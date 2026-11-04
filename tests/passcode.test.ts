import { describe, expect, it } from 'vitest';
import { ExpiredError, openPayload, openPacket, sealPayload, sealText, WrongPassphraseError } from '../src/crypto';
import { crc32, HEADER_LEN_V2, MODE_CODEART, MODE_FAKEQR, parsePacket, SLOT_LEN, VERSION_SLOT } from '../src/packet';
import { decodeFakeQr, encodeFakeQr } from '../src/qrmodes';
import { assemble, splitPacket } from '../src/split';

describe('recipient pass code (second key slot)', () => {
  it('opens with the passphrase and with the pass code, and nothing else', async () => {
    const pkt = await sealPayload({ kind: 'text', text: 'two ways in' }, 'the long master passphrase', MODE_CODEART, undefined, 0, 0, 'blue-otter-42');
    const p = parsePacket(pkt);
    expect(pkt[2]).toBe(VERSION_SLOT);
    expect(p.slot?.length).toBe(SLOT_LEN);
    expect(p.header.length).toBe(HEADER_LEN_V2 + SLOT_LEN);
    expect(await openPacket(pkt, 'the long master passphrase')).toBe('two ways in');
    expect(await openPacket(pkt, 'blue-otter-42')).toBe('two ways in');
    await expect(openPacket(pkt, 'blue-otter-43')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('adds nothing and stays version 2 when no pass code is given', async () => {
    const pkt = await sealText('plain', 'pw', MODE_CODEART);
    expect(pkt[2]).toBe(2);
    expect(parsePacket(pkt).slot).toBeUndefined();
    expect(await openPacket(pkt, 'pw')).toBe('plain');
  });

  it('lets a recipient locate a fake QR with the passcode without knowing the generated passphrase', async () => {
    const packet = await sealPayload({ kind: 'text', text: 'simple fake QR' }, 'random-generated-passphrase', MODE_FAKEQR, undefined, 0, 0, 'recipient passcode');
    const image = await encodeFakeQr(packet, 'https://example.com', 'recipient passcode');
    const decoded = await decodeFakeQr(image, 'recipient passcode');
    expect(await openPacket(decoded, 'recipient passcode')).toBe('simple fake QR');
    await expect(decodeFakeQr(image, 'wrong passcode')).rejects.toThrow();
    await expect(openPacket(decoded, 'wrong passcode')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('carries files, the animation choice and the expiry through the pass-code path', async () => {
    const data = new Uint8Array([5, 4, 3, 2, 1]);
    const exp = 2_000_000_000;
    const pkt = await sealPayload({ kind: 'file', name: 'k.bin', data }, 'master', MODE_CODEART, undefined, 9, exp, 'recipient code');
    const o = await openPayload(pkt, 'recipient code', exp * 1000 - 1000);
    expect(o.anim).toBe(9);
    expect(o.expires).toBe(exp);
    expect(o.kind === 'file' && [...o.data].join()).toBe('5,4,3,2,1');
    // and the expiry is enforced for the pass code too
    await expect(openPayload(pkt, 'recipient code', exp * 1000 + 1)).rejects.toBeInstanceOf(ExpiredError);
  });

  it('cannot be tampered with: editing the slot breaks both ways in', async () => {
    const pkt = await sealPayload({ kind: 'text', text: 'x' }, 'master', MODE_CODEART, undefined, 0, 0, 'code-word-1');
    const t = pkt.slice();
    t[HEADER_LEN_V2 + 40] ^= 1; // a byte of the wrapped key
    new DataView(t.buffer).setUint32(t.length - 4, crc32(t.subarray(0, t.length - 4)));
    await expect(openPayload(t, 'master')).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(openPayload(t, 'code-word-1')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('survives splitting across several images', async () => {
    let s = 11; // incompressible bytes so the packet needs several frames
    const data = new Uint8Array(2500).map(() => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24);
    const pkt = await sealPayload({ kind: 'file', name: 'big.bin', data }, 'master', MODE_CODEART, undefined, 0, 0, 'share me');
    const asm = assemble(splitPacket(pkt, 700));
    expect(asm.state).toBe('complete');
    if (asm.state !== 'complete') return;
    const o = await openPayload(asm.packet, 'share me');
    expect(o.kind === 'file' && o.data.length).toBe(2500);
  });

  it('refuses a pass code with the old PBKDF2 key derivation', async () => {
    await expect(sealPayload({ kind: 'text', text: 'x' }, 'pw', MODE_CODEART, { type: 'pbkdf2' }, 0, 0, 'code')).rejects.toThrow(/Argon2id/);
  });
});
