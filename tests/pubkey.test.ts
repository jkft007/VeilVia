import { describe, expect, it } from 'vitest';
import { WrongPassphraseError, openPayload, sealPayload } from '../src/crypto';
import { MODE_CODEART, PacketError, crc32, parseFrame, parsePacket } from '../src/packet';
import {
  PubKeyError,
  decodePublicKey,
  encodePublicKey,
  fingerprintWords,
  generateKeyPair,
  importIdentity,
  keyId,
  publicKeyLink,
  type KeyType,
} from '../src/pubkey';
import { FINGERPRINT_WORDS } from '../src/words';

const types: KeyType[] = ['x25519', 'p256'];
const text = (s: string) => ({ kind: 'text', text: s }) as const;

async function person(type: KeyType) {
  const k = await generateKeyPair(type);
  return { pub: { type: k.type, raw: k.raw }, id: await importIdentity(k.type, k.raw, k.pkcs8) };
}

describe.each(types)('public-key packets (%s)', (type) => {
  it('opens with the recipient key and no passphrase', async () => {
    const bob = await person(type);
    const pkt = await sealPayload(text('meet at five'), '', MODE_CODEART, undefined, 0, 0, '', 0, [bob.pub]);
    expect(parsePacket(pkt).version).toBe(4);
    expect(parseFrame(pkt).kind).toBe('packet');
    const o = await openPayload(pkt, '', Date.now(), [bob.id]);
    expect(o).toMatchObject({ kind: 'text', text: 'meet at five' });
  });

  it('does not open for someone else, or with no key, or with a passphrase that is not in it', async () => {
    const bob = await person(type);
    const eve = await person(type);
    const pkt = await sealPayload(text('secret'), '', MODE_CODEART, undefined, 0, 0, '', 0, [bob.pub]);
    await expect(openPayload(pkt, '', Date.now(), [eve.id])).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(openPayload(pkt, 'guess guess guess', Date.now(), [])).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('lets several recipients and a passphrase each open the same image', async () => {
    const a = await person(type);
    const b = await person(type);
    const other = await person(type);
    const pw = 'purple walrus climbing 8821';
    const pkt = await sealPayload(text('all hands'), pw, MODE_CODEART, undefined, 0, 0, '', 0, [a.pub, b.pub]);
    expect((await openPayload(pkt, '', Date.now(), [a.id])) as { text: string }).toMatchObject({ text: 'all hands' });
    expect((await openPayload(pkt, '', Date.now(), [b.id])) as { text: string }).toMatchObject({ text: 'all hands' });
    expect((await openPayload(pkt, pw, Date.now(), [])) as { text: string }).toMatchObject({ text: 'all hands' });
    await expect(openPayload(pkt, 'wrong wrong wrong 1', Date.now(), [other.id])).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('keeps the sender\'s animation, expiry and reading time, and carries files', async () => {
    const bob = await person(type);
    const soon = Math.floor(Date.now() / 1000) + 600;
    const pkt = await sealPayload({ kind: 'file', name: 'a.bin', data: new Uint8Array([1, 2, 3, 4]) }, '', MODE_CODEART, undefined, 9, soon, '', 30, [bob.pub]);
    const o = await openPayload(pkt, '', Date.now(), [bob.id]);
    expect(o).toMatchObject({ kind: 'file', name: 'a.bin', anim: 9, expires: soon, readSecs: 30 });
    const gone = await sealPayload(text('late'), '', MODE_CODEART, undefined, 0, 1, '', 0, [bob.pub]);
    await expect(openPayload(gone, '', Date.now(), [bob.id])).rejects.toThrow(/expired/);
  });

  it('refuses a damaged or tampered packet', async () => {
    const bob = await person(type);
    const pkt = await sealPayload(text('intact'), '', MODE_CODEART, undefined, 0, 0, '', 0, [bob.pub]);
    const bad = pkt.slice();
    bad[40] ^= 1; // inside the slot: the checksum catches it
    expect(() => parsePacket(bad)).toThrow(PacketError);
    // Fix the checksum so only the authentication can notice: the slot is part of the authenticated header.
    const sneaky = pkt.slice();
    sneaky[4 + 20] ^= 1;
    new DataView(sneaky.buffer).setUint32(sneaky.length - 4, crc32(sneaky.subarray(0, sneaky.length - 4)));
    await expect(openPayload(sneaky, '', Date.now(), [bob.id])).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('can address a packet to one recipient and still hold a passphrase pass without a recipient passcode', async () => {
    const bob = await person(type);
    await expect(sealPayload(text('x'), '', MODE_CODEART, undefined, 0, 0, 'a passcode', 0, [bob.pub])).rejects.toThrow(/passcode/);
  });
});

describe('older packets are untouched', () => {
  it('a passphrase-only packet still opens, with or without identities offered', async () => {
    const pkt = await sealPayload(text('plain old'), 'lantern oatmeal vase 7731', MODE_CODEART);
    expect(parsePacket(pkt).version).toBe(2);
    const other = await person('x25519');
    expect(await openPayload(pkt, 'lantern oatmeal vase 7731', Date.now(), [other.id])).toMatchObject({ text: 'plain old' });
  });
});

describe('public key text and fingerprints', () => {
  it('round-trips as text and as a link', async () => {
    for (const t of types) {
      const k = await person(t);
      const s = await encodePublicKey(k.pub);
      expect(s.startsWith('stpub1:')).toBe(true);
      expect(await decodePublicKey(s)).toEqual(k.pub);
      const link = await publicKeyLink(k.pub, 'https://example.test/app/');
      expect(link).toContain('#to=stpub1:');
      expect(await decodePublicKey(link)).toEqual(k.pub);
      expect(await decodePublicKey(`  ${s}\n`)).toEqual(k.pub);
    }
  });

  it('catches typing mistakes, truncation and things that are not keys', async () => {
    const k = await person('x25519');
    const s = await encodePublicKey(k.pub);
    const flip = s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21);
    await expect(decodePublicKey(flip)).rejects.toBeInstanceOf(PubKeyError);
    await expect(decodePublicKey(s.slice(0, -4))).rejects.toBeInstanceOf(PubKeyError);
    await expect(decodePublicKey('hello there')).rejects.toBeInstanceOf(PubKeyError);
    await expect(decodePublicKey('stpub1:' + 'A'.repeat(47))).rejects.toBeInstanceOf(PubKeyError);
  });

  it('gives nine stable words per key, different for different keys', async () => {
    const a = await person('x25519');
    const b = await person('x25519');
    const wa = await fingerprintWords(a.pub);
    expect(wa.split(' · ')).toHaveLength(3);
    expect(wa.replace(/ · /g, ' ').split(' ')).toHaveLength(9);
    expect(await fingerprintWords(a.pub)).toBe(wa);
    expect(await fingerprintWords(b.pub)).not.toBe(wa);
    expect(await keyId(a.pub)).toHaveLength(18);
  });

  it('has 256 distinct fingerprint words', () => {
    expect(FINGERPRINT_WORDS).toHaveLength(256);
    expect(new Set(FINGERPRINT_WORDS).size).toBe(256);
    for (const w of FINGERPRINT_WORDS) expect(w).toMatch(/^[a-z]{3,8}$/);
  });
});
