import { describe, expect, it } from 'vitest';
import { openPayload, sealPayload, WrongPassphraseError } from '../src/crypto';
import { crc32, FLAG_ANIM, MODE_CODEART, parsePacket } from '../src/packet';
import { idToStyle, STYLES, styleToId } from '../src/reveal-anim';
import { NO_ANIM } from '../src/reveal-styles';
import { assemble, splitPacket } from '../src/split';

describe('reveal animation stored with the image', () => {
  it('round-trips the sender choice for text and files, and is absent when none was chosen', async () => {
    const id = styleToId('fireworks');
    const t = await sealPayload({ kind: 'text', text: 'hello 🎆' }, 'pw', MODE_CODEART, undefined, id);
    expect(parsePacket(t).hasAnim).toBe(true);
    const o = await openPayload(t, 'pw');
    expect(o).toMatchObject({ kind: 'text', text: 'hello 🎆' });
    expect(idToStyle(o.anim)).toBe('fireworks');

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const f = await openPayload(await sealPayload({ kind: 'file', name: 'a.bin', data }, 'pw', MODE_CODEART, undefined, styleToId('moon')), 'pw');
    expect(f.kind === 'file' && f.name === 'a.bin' && [...f.data].join()).toBe('1,2,3,4,5');
    expect(idToStyle(f.anim)).toBe('moon');

    const plain = await sealPayload({ kind: 'text', text: 'no animation' }, 'pw', MODE_CODEART);
    expect(parsePacket(plain).hasAnim).toBe(false);
    const p = await openPayload(plain, 'pw');
    expect(p).toEqual({ kind: 'text', text: 'no animation' });
    expect(idToStyle(p.anim)).toBeUndefined();
  });

  it('keeps every style id stable and unique, and ignores unknown ids from a newer version', () => {
    expect(new Set(STYLES).size).toBe(STYLES.length);
    STYLES.forEach((s) => expect(idToStyle(styleToId(s))).toBe(s));
    expect(styleToId('matrix')).toBe(1); // ids are stored in images: never reorder
    expect(styleToId('wizard')).toBe(30);
    expect(STYLES.slice(30)).toEqual(['minions', 'snowglobe', 'rocket', 'lightning', 'helicopters', 'banner', 'balloons', 'quill', 'dominoes', 'treasure', 'paperplanes', 'ghosts', 'seance', 'poltergeist', 'haunted', 'dragon', 'panther', 'roadrunner', 'genie', 'fartgun', 'arrows', 'tiles', 'witches', 'redarrows', 'pirate', 'fogwriter', 'whale', 'submarine', 'bomber', 'kraken', 'thor', 'spiders', 'hatdance', 'lasers', 'earthquake', 'volcano', 'emoji', 'sharks', 'broomball', 'zombies', 'dissolve', 'sandfall', 'blackhole', 'hammersmash', 'shatter', 'burnaway', 'shredder', 'melt', 'rainwash', 'acidrain', 'icemelt', 'shaken', 'footsmash', 'builder', 'oddbods']);
    expect(STYLES.length).toBe(85);
    expect(idToStyle(250)).toBeUndefined();
    expect(idToStyle(0)).toBeUndefined();
  });

  it('is authenticated: adding or removing the flag breaks decryption', async () => {
    const withAnim = await sealPayload({ kind: 'text', text: 'x' }, 'pw', MODE_CODEART, undefined, 3);
    const t = withAnim.slice();
    t[3] &= ~FLAG_ANIM; // pretend there is no animation byte
    new DataView(t.buffer).setUint32(t.length - 4, crc32(t.subarray(0, t.length - 4)));
    await expect(openPayload(t, 'pw')).rejects.toBeInstanceOf(WrongPassphraseError);

    const without = await sealPayload({ kind: 'text', text: 'x' }, 'pw', MODE_CODEART);
    const u = without.slice();
    u[3] |= FLAG_ANIM;
    new DataView(u.buffer).setUint32(u.length - 4, crc32(u.subarray(0, u.length - 4)));
    await expect(openPayload(u, 'pw')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('survives splitting across several images', async () => {
    let s = 7; // incompressible bytes, so the packet really is larger than one frame
    const data = new Uint8Array(3000).map(() => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24);
    const pkt = await sealPayload({ kind: 'file', name: 'big.bin', data }, 'pw', MODE_CODEART, undefined, styleToId('curtain'));
    const parts = splitPacket(pkt, 700);
    expect(parts.length).toBeGreaterThan(1);
    const asm = assemble(parts);
    expect(asm.state).toBe('complete');
    if (asm.state !== 'complete') return;
    const o = await openPayload(asm.packet, 'pw');
    expect(idToStyle(o.anim)).toBe('curtain');
  });
});

describe('"no nonsense": show the message with no animation', () => {
  it('is stored with the image like an animation choice, and is not a style', async () => {
    const t = await sealPayload({ kind: 'text', text: 'plain and simple' }, 'pw', MODE_CODEART, undefined, NO_ANIM);
    const o = await openPayload(t, 'pw');
    expect(o).toMatchObject({ text: 'plain and simple', anim: NO_ANIM });
    expect(idToStyle(o.anim)).toBeUndefined();
    expect(STYLES.length).toBeLessThan(NO_ANIM);
  });
});
