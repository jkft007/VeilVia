import { describe, expect, it } from 'vitest';
import { assemble, splitPacket } from '../src/split';
import { openPayload, sealPayload } from '../src/crypto';
import { decodeCodeArt, encodeCodeArt } from '../src/codeart';
import { decodeFakeQr, decodePlainQr, encodeFakeQr, encodePlainQr } from '../src/qrmodes';
import { MODE_CODEART, MODE_FAKEQR, MODE_QR, parsePart } from '../src/packet';
import { decodeImageSheet, encodeImageSheet } from '../src/imagesheet';

const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) out[i] = ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
  return out;
};

describe('split / assemble', () => {
  it('leaves small packets alone', () => {
    const packet = bytes(2500, 3);
    expect(splitPacket(packet, 4000)).toEqual([packet]);
  });

  it('splits into numbered parts and reassembles in any order', async () => {
    const real = await sealPayload({ kind: 'file', name: 'a.bin', data: bytes(2400, 9) }, 'pw', MODE_CODEART);
    const frames = splitPacket(real, 700);
    expect(frames.length).toBeGreaterThan(3);
    expect(frames.every((f) => f.length <= 700)).toBe(true);
    const r = assemble([...frames].reverse());
    expect(r.state).toBe('complete');
    if (r.state === 'complete') expect(r.packet).toEqual(real);
  });

  it('reports exactly which parts are missing, and tolerates duplicates', async () => {
    const real = await sealPayload({ kind: 'file', name: 'b.bin', data: bytes(1500, 5) }, 'pw', MODE_CODEART);
    const frames = splitPacket(real, 400);
    const r = assemble([frames[0], frames[0], frames[2]]);
    expect(r).toMatchObject({ state: 'incomplete', have: 2, total: frames.length });
    if (r.state === 'incomplete') expect(r.missing).toEqual(frames.map((_, i) => i).filter((i) => i !== 0 && i !== 2));
  });

  it('ignores a damaged part and prefers the most recently added set', async () => {
    const a = splitPacket(await sealPayload({ kind: 'file', name: 'a', data: bytes(1500, 1) }, 'pw', MODE_CODEART), 500);
    const b = splitPacket(await sealPayload({ kind: 'file', name: 'b', data: bytes(1500, 2) }, 'pw', MODE_CODEART), 500);
    const bad = a[1].slice();
    bad[20] ^= 0xff;
    expect(parsePart(a[0]).setId).not.toBe(parsePart(b[0]).setId);
    expect(assemble([a[0], bad, ...b]).state).toBe('complete');
    const onlyDamaged = assemble([a[0], bad, a[2]]);
    expect(onlyDamaged).toMatchObject({ state: 'incomplete', have: 2 });
  });

  it('refuses absurd part counts', () => {
    expect(() => splitPacket(bytes(100000), 300)).toThrow(/most is 60/);
  });
});

describe('split through real image styles', () => {
  it('recovers all encrypted parts from a single clipboard sheet', async () => {
    const data = bytes(2400, 9);
    const packet = await sealPayload({ kind: 'file', name: 'sheet.bin', data }, 'pw', MODE_CODEART);
    const parts = splitPacket(packet, 700).map((frame) => encodeCodeArt(frame));
    const recovered = decodeImageSheet(encodeImageSheet(parts))!;
    const assembled = assemble(recovered.map(decodeCodeArt));
    expect(assembled.state).toBe('complete');
    if (assembled.state === 'complete') {
      const out = await openPayload(assembled.packet, 'pw');
      expect(out.kind === 'file' && out.data).toEqual(data);
    }
  });

  it('code art: a 7 KB file over several images', async () => {
    const data = bytes(7000, 4);
    const packet = await sealPayload({ kind: 'file', name: 'doc.pdf', data }, 'pw', MODE_CODEART);
    const frames = splitPacket(packet, 3000);
    expect(frames.length).toBe(3);
    const r = assemble(frames.map((f) => decodeCodeArt(encodeCodeArt(f))));
    expect(r.state).toBe('complete');
    if (r.state === 'complete') {
      const out = await openPayload(r.packet, 'pw');
      expect(out.kind === 'file' && out.data).toEqual(data);
    }
  });

  it('plain QR: 3 KB over several codes', async () => {
    const data = bytes(3000, 6);
    const packet = await sealPayload({ kind: 'file', name: 'k.bin', data }, 'pw', MODE_QR);
    const frames = splitPacket(packet, 1200);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const r = assemble(frames.map((f) => decodePlainQr(encodePlainQr(f))));
    expect(r.state).toBe('complete');
    if (r.state === 'complete') {
      const out = await openPayload(r.packet, 'pw');
      expect(out.kind === 'file' && out.data).toEqual(data);
    }
  });

  it('fake QR: 600 bytes over several decoys', async () => {
    const data = bytes(600, 8);
    const packet = await sealPayload({ kind: 'file', name: 'n.bin', data }, 'pw', MODE_FAKEQR);
    const frames = splitPacket(packet, 300);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const decoded: Uint8Array[] = [];
    for (const f of frames) decoded.push(await decodeFakeQr(await encodeFakeQr(f, 'https://example.com', 'pw'), 'pw'));
    const r = assemble(decoded);
    expect(r.state).toBe('complete');
    if (r.state === 'complete') {
      const out = await openPayload(r.packet, 'pw');
      expect(out.kind === 'file' && out.data).toEqual(data);
    }
  });
});
