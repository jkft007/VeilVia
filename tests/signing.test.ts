import { describe, expect, it } from 'vitest';
import { decodeCodeArt, encodeCodeArt, type Rgba } from '../src/codeart';
import { ExpiredError, openPayload, sealPayload, WrongPassphraseError } from '../src/crypto';
import { argon2Bytes } from '../src/kdf';
import { MODE_CODEART, MODE_DCT, MODE_FAKEQR, MODE_QR, MODE_STEGO, PacketError, SIGNED_HEADER_LEN, crc32, finishPacket, parseFrame, parsePacket } from '../src/packet';
import { findPhoto, hidePhoto } from '../src/photo';
import { canUse, decodePublicKey, encodePublicKey, generateKeyPair, importIdentity, publicKeyLink, type KeyType } from '../src/pubkey';
import { decodeFakeQr, decodePlainQr, encodeFakeQr, encodePlainQr } from '../src/qrmodes';
import { SignatureError, senderStatus, signPacket } from '../src/signing';
import { assemble, splitPacket } from '../src/split';

const text = { kind: 'text', text: 'Meet by the old bridge at nine.' } as const;
const pass = 'lantern oatmeal river 7731';
const signer = async () => {
  const k = await generateKeyPair('ed25519');
  return importIdentity(k.type, k.raw, k.pkcs8);
};
const repairCrc = (packet: Uint8Array) => {
  new DataView(packet.buffer, packet.byteOffset).setUint32(packet.length - 4, crc32(packet.subarray(0, packet.length - 4)));
};

describe('Ed25519 sender signatures', () => {
  it.each<KeyType>(['x25519', 'p256'])('authenticates a sender independently of the %s recipient key', async (type) => {
    const alice = await signer();
    const bobKey = await generateKeyPair(type);
    const bob = await importIdentity(type, bobKey.raw, bobKey.pkcs8);
    const packet = await sealPayload(text, '', MODE_CODEART, undefined, 0, 0, '', 0, [bob], false, alice);
    expect(parsePacket(packet).version).toBe(5);
    expect(parseFrame(packet).kind).toBe('packet');
    expect(await openPayload(packet, '', Date.now(), [bob], alice)).toMatchObject({ ...text, sender: { type: 'ed25519', raw: alice.raw } });
  });

  describe('encrypted Ed25519 sender signatures', () => {
    it.each<KeyType>(['x25519', 'p256'])('hides the sender until an authorized %s recipient or passphrase holder decrypts', async (type) => {
      const alice = await signer();
      const bobKey = await generateKeyPair(type);
      const bob = await importIdentity(type, bobKey.raw, bobKey.pkcs8);
      const packet = await sealPayload(text, pass, MODE_CODEART, undefined, 0, 0, '', 0, [bob], false, alice, 'private');
      expect(parsePacket(packet)).toMatchObject({ version: 6, privateSignature: true });
      expect(parsePacket(packet).signature).toBeUndefined();
      expect(Buffer.from(packet).includes(Buffer.from(alice.raw))).toBe(false);
      expect(await openPayload(packet, '', Date.now(), [bob], alice)).toMatchObject({ ...text, sender: { type: 'ed25519', raw: alice.raw } });
      expect(await openPayload(packet, pass, Date.now(), [], alice)).toMatchObject(text);
      await expect(openPayload(packet, 'wrong passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
    });

    it.each(['pbkdf2', 'argon2id', 'passcode'])('preserves private signed files, compression and settings with %s encryption', async (kind) => {
      const alice = await signer();
      const payload = { kind: 'file', name: 'private.txt', data: new TextEncoder().encode('private file contents '.repeat(60)) } as const;
      const expiry = Math.floor(Date.now() / 1000) + 600;
      const code = kind === 'passcode' ? 'recipient code 882' : '';
      const packet = await sealPayload(payload, pass, MODE_CODEART, kind === 'pbkdf2' ? { type: 'pbkdf2' } : undefined, 9, expiry, code, 30, [], true, alice, 'private');
      expect(parsePacket(packet).compressed).toBe(true);
      expect(Buffer.from(packet).includes(Buffer.from(alice.raw))).toBe(false);
      for (const pw of code ? [pass, code] : [pass]) {
        expect(await openPayload(packet, pw, Date.now(), [], alice)).toMatchObject({ ...payload, anim: 9, expires: expiry, readSecs: 30, readLocked: true, sender: { raw: alice.raw } });
      }
      await expect(openPayload(packet, pass, expiry * 1000 + 1, [], alice)).rejects.toBeInstanceOf(ExpiredError);
    });

    it('rejects forged identities, unsigned replacements and invalid signing key pairs', async () => {
      const alice = await signer();
      const eve = await signer();
      const forged = await sealPayload(text, pass, MODE_CODEART, undefined, 0, 1, '', 0, [], false, eve, 'private');
      await expect(openPayload(forged, pass, Date.now(), [], alice)).rejects.toThrow(/required sender/);
      const unsigned = await sealPayload(text, pass, MODE_CODEART);
      await expect(openPayload(unsigned, pass, Date.now(), [], alice)).rejects.toThrow(/Unsigned message/);
      await expect(sealPayload(text, pass, MODE_CODEART, undefined, 0, 0, '', 0, [], false, { ...alice, raw: eve.raw }, 'private')).rejects.toBeInstanceOf(SignatureError);
      const encryptionKey = await generateKeyPair('x25519');
      const encryptionIdentity = await importIdentity(encryptionKey.type, encryptionKey.raw, encryptionKey.pkcs8);
      await expect(sealPayload(text, pass, MODE_CODEART, undefined, 0, 0, '', 0, [], false, encryptionIdentity, 'private')).rejects.toThrow(/Ed25519/);
    });

    it('rejects changes made by a passphrase holder even if they recompute valid encryption and checksums', async () => {
      const alice = await signer();
      const eve = await signer();
      const packet = await sealPayload(text, pass, MODE_CODEART, undefined, 9, 0, '', 30, [], true, alice, 'private');
      const p = parsePacket(packet);
      if (p.kdf.type !== 'argon2id') throw new Error('expected Argon2id');
      const raw = await argon2Bytes(pass, p.salt, p.kdf.memLog2, p.kdf.iterations);
      const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.iv as BufferSource, additionalData: p.header as BufferSource }, key, p.ciphertext as BufferSource));
      const reseal = async (data: Uint8Array, header = p.header.slice()) => {
        new DataView(header.buffer, header.byteOffset).setUint32(header.length - 4, data.length + 16);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: p.iv as BufferSource, additionalData: header as BufferSource }, key, data as BufferSource));
        return finishPacket(header, ciphertext);
      };
      for (const offset of [0, 32, 96]) {
        const altered = plain.slice();
        if (offset === 0) altered.set(eve.raw);
        else altered[offset] ^= 1;
        await expect(openPayload(await reseal(altered), pass)).rejects.toBeInstanceOf(SignatureError);
      }
      const changedHeader = p.header.slice();
      changedHeader[3] ^= 0x20;
      await expect(openPayload(await reseal(plain, changedHeader), pass)).rejects.toBeInstanceOf(SignatureError);
      await expect(openPayload(await reseal(plain.slice(0, 95)), pass)).rejects.toBeInstanceOf(SignatureError);
      await expect(openPayload(await reseal(plain.subarray(96)), pass, Date.now(), [], alice)).rejects.toBeInstanceOf(SignatureError);
    });

    it('refuses truncated, nested and downgraded private signature packets', async () => {
      const alice = await signer();
      const packet = await sealPayload(text, pass, MODE_CODEART, undefined, 0, 0, '', 0, [], false, alice, 'private');
      expect(() => parsePacket(packet.slice(0, -1))).toThrow(PacketError);
      const nested = packet.slice();
      nested[4] = 5;
      repairCrc(nested);
      expect(() => parsePacket(nested)).toThrow(/unsupported private signature encryption version/);
      await expect(signPacket(packet, alice)).rejects.toThrow(/already signed/);
      const downgraded = new Uint8Array(packet.length - 1);
      downgraded.set(packet.subarray(0, 4));
      downgraded[2] = packet[4];
      downgraded.set(packet.subarray(5), 4);
      repairCrc(downgraded);
      await expect(openPayload(downgraded, pass)).rejects.toBeInstanceOf(WrongPassphraseError);
      await expect(openPayload(downgraded, pass, Date.now(), [], alice)).rejects.toThrow(/Unsigned message/);
    });
  });

  it.each(['pbkdf2', 'argon2id', 'passcode'])('preserves signed files and settings with %s encryption', async (kind) => {
    const alice = await signer();
    const payload = { kind: 'file', name: 'note.txt', data: new TextEncoder().encode('a compressible file '.repeat(60)) } as const;
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const code = kind === 'passcode' ? 'another long code 88' : '';
    const packet = await sealPayload(payload, pass, MODE_CODEART, kind === 'pbkdf2' ? { type: 'pbkdf2' } : undefined, 9, expiry, code, 30, [], true, alice);
    for (const pw of code ? [pass, code] : [pass]) {
      expect(await openPayload(packet, pw, Date.now(), [], alice)).toMatchObject({ ...payload, anim: 9, expires: expiry, readSecs: 30, readLocked: true, sender: { raw: alice.raw } });
    }
  });

  it('rejects altered signatures, substituted signing keys, and modified recipient slots or ciphertext even after checksums are repaired', async () => {
    const alice = await signer();
    const bob = await generateKeyPair('x25519');
    const eve = await signer();
    const packet = await sealPayload(text, '', MODE_CODEART, undefined, 0, 0, '', 0, [bob], false, alice);
    const innerLen = new DataView(packet.buffer).getUint32(36);
    const inner = packet.subarray(SIGNED_HEADER_LEN, SIGNED_HEADER_LEN + innerLen);
    for (const offset of [4, SIGNED_HEADER_LEN + innerLen, SIGNED_HEADER_LEN + 25, SIGNED_HEADER_LEN + parsePacket(inner).header.length]) {
      const bad = packet.slice();
      if (offset === 4) bad.set(eve.raw, 4);
      else bad[offset] ^= 1;
      repairCrc(bad.subarray(SIGNED_HEADER_LEN, SIGNED_HEADER_LEN + innerLen));
      repairCrc(bad);
      await expect(openPayload(bad, '')).rejects.toBeInstanceOf(SignatureError);
    }
  });

  it('does not accept an attacker who can encrypt to the same recipient and claim the same name', async () => {
    const alice = await signer();
    const eve = await signer();
    const bob = await generateKeyPair('x25519');
    const forged = await sealPayload(text, '', MODE_CODEART, undefined, 0, 0, '', 0, [bob], false, eve);
    await expect(openPayload(forged, '', Date.now(), [], alice)).rejects.toThrow(/required sender/);
    const trust = await senderStatus(eve, [{ type: 'ed25519', pub: alice.raw, label: 'Alice', verified: true }, { type: 'ed25519', pub: eve.raw, label: 'Alice' }]);
    expect(trust.trusted).toBe(false);
    expect(trust.message).toMatch(/unknown sender/);
  });

  it('refuses stripped signatures when a sender is required, while leaving legacy unsigned messages readable otherwise', async () => {
    const alice = await signer();
    const unsigned = await sealPayload(text, pass, MODE_CODEART);
    const signed = await signPacket(unsigned, alice);
    const len = new DataView(signed.buffer).getUint32(36);
    const stripped = signed.slice(SIGNED_HEADER_LEN, SIGNED_HEADER_LEN + len);
    expect(stripped).toEqual(unsigned);
    await expect(openPayload(stripped, pass, Date.now(), [], alice)).rejects.toThrow(/Unsigned message/);
    const opened = await openPayload(stripped, pass);
    expect(opened).toMatchObject(text);
    expect(opened.sender).toBeUndefined();
    expect(await senderStatus(opened.sender, [])).toMatchObject({ trusted: false, message: expect.stringContaining('Unsigned message') });
  });

  it('identifies only signing fingerprints explicitly checked by the recipient', async () => {
    const alice = await signer();
    const contact = { type: 'ed25519' as const, pub: alice.raw, label: 'Alice' };
    expect((await senderStatus(alice, [contact])).trusted).toBe(false);
    expect(await senderStatus(alice, [{ ...contact, verified: true }])).toMatchObject({ trusted: true, message: expect.stringContaining('Verified sender: Alice') });
  });

  it('rejects malformed, truncated and nested signed packets', async () => {
    const alice = await signer();
    const packet = await signPacket(await sealPayload(text, pass, MODE_CODEART), alice);
    expect(() => parsePacket(packet.slice(0, -1))).toThrow(PacketError);
    const bad = packet.slice();
    bad[SIGNED_HEADER_LEN + 2] = 5;
    repairCrc(bad);
    expect(() => parsePacket(bad)).toThrow(/unsupported signed packet version/);
    await expect(signPacket(packet, alice)).rejects.toThrow(/already signed/);
  });

  it('keeps signing keys distinct from encryption keys and catches mismatched signing key pairs', async () => {
    const alice = await signer();
    const eve = await signer();
    expect(await decodePublicKey(await encodePublicKey(alice))).toEqual({ type: 'ed25519', raw: alice.raw });
    expect(await canUse('ed25519')).toBe(false);
    await expect(publicKeyLink(alice, 'https://example.test/')).rejects.toThrow(/cannot receive/);
    await expect(sealPayload(text, '', MODE_CODEART, undefined, 0, 0, '', 0, [alice])).rejects.toThrow(/encryption recipient/);
    const unsigned = await sealPayload(text, pass, MODE_CODEART);
    await expect(signPacket(unsigned, { ...alice, raw: eve.raw })).rejects.toBeInstanceOf(SignatureError);
  });
});

function cover(): Rgba {
  const width = 640, height = 480;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    data[o] = 120 + 50 * Math.sin(x / 29);
    data[o + 1] = 110 + 70 * Math.cos(y / 37);
    data[o + 2] = 100 + 50 * Math.sin((x + y) / 43);
    data[o + 3] = 255;
  }
  return { width, height, data };
}

describe.each(['public', 'private'] as const)('%s signed messages through images', (visibility) => {
  it.each(['codeart', 'qr', 'fakeqr', 'lsb', 'dct'])('retains a verifiable signature through %s', async (mode) => {
    const alice = await signer();
    const modes: Record<string, number> = { codeart: MODE_CODEART, qr: MODE_QR, fakeqr: MODE_FAKEQR, lsb: MODE_STEGO, dct: MODE_DCT };
    const packet = await sealPayload(text, pass, modes[mode], undefined, 0, 0, '', 0, [], false, alice, visibility);
    let decoded: Uint8Array;
    if (mode === 'codeart') decoded = decodeCodeArt(encodeCodeArt(packet));
    else if (mode === 'qr') decoded = decodePlainQr(encodePlainQr(packet));
    else if (mode === 'fakeqr') decoded = await decodeFakeQr(await encodeFakeQr(packet, 'https://example.test/', pass), pass);
    else {
      const kind = mode as 'lsb' | 'dct';
      const image = await hidePhoto(kind, cover(), [{ pass, packet }]);
      decoded = (await findPhoto(kind, image, pass, (f) => void parseFrame(f))).frame;
    }
    expect(await openPayload(decoded, pass, Date.now(), [], alice)).toMatchObject({ ...text, sender: { raw: alice.raw } });
  });

  it('verifies a signed packet only after all split parts have been assembled', async () => {
    const alice = await signer();
    const packet = await sealPayload(text, pass, MODE_CODEART, undefined, 0, 0, '', 0, [], false, alice, visibility);
    const frames = splitPacket(packet, 110).map((part) => decodeCodeArt(encodeCodeArt(part))).reverse();
    expect(frames.length).toBeGreaterThan(1);
    const assembled = assemble(frames);
    expect(assembled.state).toBe('complete');
    if (assembled.state !== 'complete') throw new Error('incomplete');
    expect(await openPayload(assembled.packet, pass, Date.now(), [], alice)).toMatchObject(text);
  });
});
