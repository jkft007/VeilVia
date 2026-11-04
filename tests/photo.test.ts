import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import type { Rgba } from '../src/codeart';
import { openPayload, sealPayload } from '../src/crypto';
import { embedDct } from '../src/dct';
import { embed } from '../src/stego';
import { MODE_DCT, MODE_STEGO, parseFrame } from '../src/packet';
import { findPhoto, hidePhoto, photoCapacity, photoLayout, type PhotoKind } from '../src/photo';

const noise = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

/** A smooth gradient with a little noise, like a photograph. */
function cover(w: number, h: number): Rgba {
  const n = noise(w * h, 9);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = (x * 255) / w + (n[y * w + x] % 12);
      data[o + 1] = (y * 255) / h + (n[y * w + x] % 9);
      data[o + 2] = 120 + 60 * Math.sin(x / 25) + (n[y * w + x] % 7);
      data[o + 3] = 255;
    }
  return { width: w, height: h, data };
}

function jpegRoundtrip(img: Rgba, quality: number): Rgba {
  const enc = jpeg.encode({ width: img.width, height: img.height, data: img.data as never }, quality);
  const dec = jpeg.decode(enc.data, { useTArray: true });
  return { width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data) };
}

const ok = (f: Uint8Array) => void parseFrame(f);
const seal = (text: string, pass: string, kind: PhotoKind) => sealPayload({ kind: 'text', text }, pass, kind === 'dct' ? MODE_DCT : MODE_STEGO);
const reveal = async (kind: PhotoKind, img: Rgba, typed: string) => {
  const r = await findPhoto(kind, img, typed, ok);
  const p = await openPayload(r.frame, r.pass);
  return p.kind === 'text' ? p.text : '';
};

const A = 'alpha river lantern 4471';
const B = 'bravo canyon violin 9082';
const C = 'charlie meadow ember 3315';

for (const kind of ['dct', 'lsb'] as PhotoKind[]) {
  const img = () => (kind === 'dct' ? cover(640, 480) : cover(220, 160));

  describe(`photo with several records (${kind})`, () => {
    it('one message with no passcode is read exactly as before', async () => {
      const packet = await seal('only one', A, kind);
      const old = kind === 'dct' ? await embedDct(img(), packet, A) : await embed(img(), packet, A);
      expect(await reveal(kind, old, A)).toBe('only one');
      const fresh = await hidePhoto(kind, img(), [{ pass: A, packet }]);
      expect(fresh.data).toEqual(old.data); // the single-message layout is unchanged
      await expect(findPhoto(kind, old, 'wrong passphrase 123', ok)).rejects.toThrow();
    });

    it('a passcode finds the message through its locator, and the passphrase still works', async () => {
      const packet = await seal('via code', A, kind);
      const out = await hidePhoto(kind, img(), [{ pass: A, passcode: 'orange 77 kettle', packet }]);
      expect(await reveal(kind, out, 'orange 77 kettle')).toBe('via code');
      expect(await reveal(kind, out, A)).toBe('via code');
      await expect(findPhoto(kind, out, 'orange 77 kettlf', ok)).rejects.toThrow();
    });

    it('several messages: each passphrase or passcode shows only its own', async () => {
      const msgs = [
        { pass: A, packet: await seal('first secret', A, kind) },
        { pass: B, passcode: 'bravo code 12345', packet: await seal('second secret', B, kind) },
        { pass: C, passcode: 'charlie code 98765', packet: await seal('third secret', C, kind) },
      ];
      const out = await hidePhoto(kind, img(), msgs);
      expect(await reveal(kind, out, A)).toBe('first secret');
      expect(await reveal(kind, out, B)).toBe('second secret');
      expect(await reveal(kind, out, 'bravo code 12345')).toBe('second secret');
      expect(await reveal(kind, out, C)).toBe('third secret');
      expect(await reveal(kind, out, 'charlie code 98765')).toBe('third secret');
      await expect(findPhoto(kind, out, 'delta nothing here 1', ok)).rejects.toThrow();
    });

    it('four messages fit and all open', async () => {
      const passes = [A, B, C, 'delta forest anchor 2204'];
      const msgs = await Promise.all(passes.map(async (p, i) => ({ pass: p, packet: await seal(`m${i}`, p, kind) })));
      const out = await hidePhoto(kind, img(), msgs);
      for (let i = 0; i < 4; i++) expect(await reveal(kind, out, passes[i])).toBe(`m${i}`);
    });

    it('refuses repeated keys, an overlong passphrase with a passcode, and too many or too big messages', async () => {
      const p1 = await seal('x', A, kind);
      const p2 = await seal('y', B, kind);
      await expect(hidePhoto(kind, img(), [{ pass: A, packet: p1 }, { pass: A, packet: p2 }])).rejects.toThrow(/different/);
      await expect(hidePhoto(kind, img(), [{ pass: A, passcode: A, packet: p1 }])).rejects.toThrow(/different/);
      await expect(hidePhoto(kind, img(), [{ pass: 'x'.repeat(70), passcode: 'some code 123456', packet: p1 }])).rejects.toThrow(/at most/);
      const five = await Promise.all(['a1', 'b2', 'c3', 'd4', 'e5'].map(async (p) => ({ pass: p + ' pass phrase 8888', packet: p1 })));
      await expect(hidePhoto(kind, img(), five)).rejects.toThrow(/1 to 4/);
      const big = new Uint8Array(photoCapacity(kind, img(), { nMsg: 2, nLoc: 0 }) + 1);
      await expect(hidePhoto(kind, img(), [{ pass: A, packet: big }, { pass: B, packet: p2 }])).rejects.toThrow(/Too much data/);
    });

    it('more messages and passcodes leave each message less room', () => {
      const one = photoCapacity(kind, img(), photoLayout([{}]));
      const two = photoCapacity(kind, img(), photoLayout([{}, {}]));
      const twoCoded = photoCapacity(kind, img(), photoLayout([{ passcode: 'a' }, { passcode: 'b' }]));
      expect(two).toBeLessThan(one * 0.6);
      expect(twoCoded).toBeLessThan(two);
    });
  });
}

describe('photo with several records survives JPEG (dct)', () => {
  it('two messages and a passcode after quality 70 and 50 recompression', async () => {
    const msgs = [
      { pass: A, packet: await seal('first secret', A, 'dct') },
      { pass: B, passcode: 'bravo code 12345', packet: await seal('second secret', B, 'dct') },
    ];
    const out = await hidePhoto('dct', cover(640, 480), msgs);
    for (const q of [70, 50]) {
      const j = jpegRoundtrip(out, q);
      expect(await reveal('dct', j, A)).toBe('first secret');
      expect(await reveal('dct', j, 'bravo code 12345')).toBe('second secret');
    }
  });
});
