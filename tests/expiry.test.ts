import { describe, expect, it } from 'vitest';
import { ExpiredError, NEVER_CLEAR, openPayload, sealPayload, WrongPassphraseError } from '../src/crypto';
import { crc32, FLAG_EXPIRY, FLAG_READ, MODE_CODEART, parsePacket } from '../src/packet';

const NOW = 1_800_000_000_000; // an arbitrary fixed "current time" in ms

describe('reading time stored with the image', () => {
  it('round-trips with every other setting, and "until cleared" is distinct', async () => {
    const exp = NOW / 1000 + 500;
    const pkt = await sealPayload({ kind: 'text', text: 'timed' }, 'pw', MODE_CODEART, undefined, 3, exp, '', 15);
    expect(parsePacket(pkt).hasRead).toBe(true);
    expect(parsePacket(pkt).mode).toBe(MODE_CODEART); // the mode survives the extra flag bit
    expect(await openPayload(pkt, 'pw', NOW)).toMatchObject({ text: 'timed', anim: 3, expires: exp, readSecs: 15 });

    const forever = await sealPayload({ kind: 'text', text: 'k' }, 'pw', MODE_CODEART, undefined, 0, 0, '', NEVER_CLEAR);
    expect((await openPayload(forever, 'pw', NOW)).readSecs).toBe(NEVER_CLEAR);
  });

  it('works through the passcode and for files, and is absent by default', async () => {
    const data = new Uint8Array([1, 2]);
    const pkt = await sealPayload({ kind: 'file', name: 'n.bin', data }, 'master', MODE_CODEART, undefined, 0, 0, 'the code', 30);
    const o = await openPayload(pkt, 'the code', NOW);
    expect(o.readSecs).toBe(30);
    expect(o.kind === 'file' && [...o.data].join()).toBe('1,2');
    const none = await sealPayload({ kind: 'text', text: 'd' }, 'pw', MODE_CODEART);
    expect(parsePacket(none).hasRead).toBe(false);
    expect((await openPayload(none, 'pw', NOW)).readSecs).toBeUndefined();
  });

  it('stores a locked reading time while keeping unlocked messages compatible', async () => {
    const locked = await sealPayload({ kind: 'text', text: 'fixed time' }, 'pw', MODE_CODEART, undefined, 0, 0, '', 30, [], true);
    expect(await openPayload(locked, 'pw', NOW)).toMatchObject({ text: 'fixed time', readSecs: 30, readLocked: true });

    const unlocked = await sealPayload({ kind: 'text', text: 'adjustable time' }, 'pw', MODE_CODEART, undefined, 0, 0, '', 30);
    expect(await openPayload(unlocked, 'pw', NOW)).toMatchObject({ text: 'adjustable time', readSecs: 30 });
    expect((await openPayload(unlocked, 'pw', NOW)).readLocked).toBeUndefined();
  });

  it('cannot be stretched by editing the header: the flag is authenticated', async () => {
    const pkt = await sealPayload({ kind: 'text', text: 'x' }, 'pw', MODE_CODEART, undefined, 0, 0, '', 10);
    const t = pkt.slice();
    t[3] &= ~FLAG_READ;
    new DataView(t.buffer).setUint32(t.length - 4, crc32(t.subarray(0, t.length - 4)));
    await expect(openPayload(t, 'pw', NOW)).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe('optional expiry stored in the encrypted payload', () => {
  it('opens before the expiry time and reports it', async () => {
    const exp = NOW / 1000 + 3600;
    const pkt = await sealPayload({ kind: 'text', text: 'still fine' }, 'pw', MODE_CODEART, undefined, 0, exp);
    expect(parsePacket(pkt).hasExpiry).toBe(true);
    const o = await openPayload(pkt, 'pw', NOW);
    expect(o).toMatchObject({ kind: 'text', text: 'still fine', expires: exp });
  });

  it('refuses to show the secret once the time has passed, and says when it expired', async () => {
    const exp = NOW / 1000 + 60;
    const pkt = await sealPayload({ kind: 'text', text: 'too late' }, 'pw', MODE_CODEART, undefined, 0, exp);
    const later = NOW + 61_000;
    const err = await openPayload(pkt, 'pw', later).catch((e) => e);
    expect(err).toBeInstanceOf(ExpiredError);
    expect(err.expires).toBe(exp);
    expect(err.message).toMatch(/expired/);
    await expect(openPayload(pkt, 'pw', exp * 1000)).rejects.toBeInstanceOf(ExpiredError); // the boundary counts as expired
  });

  it('does not tell a wrong guess anything about the expiry', async () => {
    const pkt = await sealPayload({ kind: 'text', text: 'x' }, 'pw', MODE_CODEART, undefined, 0, NOW / 1000 - 10);
    await expect(openPayload(pkt, 'wrong', NOW)).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('works together with an animation choice, and for files', async () => {
    const exp = NOW / 1000 + 100;
    const data = new Uint8Array([9, 8, 7]);
    const pkt = await sealPayload({ kind: 'file', name: 'k.bin', data }, 'pw', MODE_CODEART, undefined, 5, exp);
    const o = await openPayload(pkt, 'pw', NOW);
    expect(o.anim).toBe(5);
    expect(o.expires).toBe(exp);
    expect(o.kind === 'file' && o.name === 'k.bin' && [...o.data].join()).toBe('9,8,7');
    const t = await sealPayload({ kind: 'text', text: 'both' }, 'pw', MODE_CODEART, undefined, 7, exp);
    expect(await openPayload(t, 'pw', NOW)).toMatchObject({ text: 'both', anim: 7, expires: exp });
  });

  it('adds nothing when no expiry is set', async () => {
    const pkt = await sealPayload({ kind: 'text', text: 'forever' }, 'pw', MODE_CODEART);
    expect(parsePacket(pkt).hasExpiry).toBe(false);
    const o = await openPayload(pkt, 'pw', NOW * 10);
    expect(o).toEqual({ kind: 'text', text: 'forever' });
  });

  it('cannot be removed by editing the header: the flag is authenticated', async () => {
    const pkt = await sealPayload({ kind: 'text', text: 'x' }, 'pw', MODE_CODEART, undefined, 0, NOW / 1000 - 10);
    const t = pkt.slice();
    t[3] &= ~FLAG_EXPIRY; // try to strip the expiry
    new DataView(t.buffer).setUint32(t.length - 4, crc32(t.subarray(0, t.length - 4)));
    await expect(openPayload(t, 'pw', NOW)).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});
