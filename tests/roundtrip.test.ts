import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { decodeBuffer, encodeBuffer } from '../src/ecc';
import { openPacket, openPayload, sealPayload, sealText, WrongPassphraseError } from '../src/crypto';
import { decodeCodeArt, decodeMicrodot, encodeCodeArt, encodeMicrodot, MAX_MICRODOT_PACKET, type Rgba } from '../src/codeart';
import { embed, extract, stegoCapacity } from '../src/stego';
import { buildPart, MODE_CODEART, MODE_MICRODOT, MODE_STEGO, parseFrame, parsePacket } from '../src/packet';
import { generateKeyPair, importIdentity } from '../src/pubkey';
import { assemble, splitPacket } from '../src/split';

const rnd = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

function jpegRoundtrip(img: Rgba, quality: number): Rgba {
  const enc = jpeg.encode({ width: img.width, height: img.height, data: img.data as never }, quality);
  const dec = jpeg.decode(enc.data, { useTArray: true });
  return { width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data) };
}

function scale(img: Rgba, f: number): Rgba {
  const w = Math.round(img.width * f), h = Math.round(img.height * f);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / f)), sy = Math.min(img.height - 1, Math.floor(y / f));
      for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = img.data[(sy * img.width + sx) * 4 + c];
    }
  return { width: w, height: h, data };
}

describe('reed-solomon', () => {
  for (const len of [1, 50, 191, 192, 1000]) {
    it(`corrects errors, len ${len}`, () => {
      const data = rnd(len, len);
      const enc = encodeBuffer(data);
      const bad = enc.slice();
      // corrupt a burst plus scattered bytes (well under capacity)
      for (let i = 0; i < Math.min(10, bad.length); i++) bad[i + 3 < bad.length ? i + 3 : i] ^= 0xa5;
      expect(decodeBuffer(bad, len)).toEqual(data);
    });
  }
  it('throws when overwhelmed', () => {
    const enc = encodeBuffer(rnd(100));
    for (let i = 0; i < enc.length; i += 2) enc[i] ^= 0xff;
    expect(() => decodeBuffer(enc, 100)).toThrow();
  });
});

describe('crypto', () => {
  it('roundtrips unicode', async () => {
    const text = 'héllo 世界 🔐\nline two';
    const p = await sealText(text, 'correct horse', MODE_CODEART);
    expect(parsePacket(p).mode).toBe(MODE_CODEART);
    expect(await openPacket(p, 'correct horse')).toBe(text);
  });
  it('rejects wrong passphrase', async () => {
    const p = await sealText('secret', 'right', MODE_CODEART);
    await expect(openPacket(p, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });
  it('handles empty and large text', async () => {
    expect(await openPacket(await sealText('', 'p', 1), 'p')).toBe('');
    const big = 'lorem ipsum '.repeat(500);
    expect(await openPacket(await sealText(big, 'p', 1), 'p')).toBe(big);
  });
});

describe('code-art', () => {
  it('roundtrips a sealed secret', async () => {
    const p = await sealText('meet at dawn', 'pw', MODE_CODEART);
    expect(await openPacket(decodeCodeArt(encodeCodeArt(p)), 'pw')).toBe('meet at dawn');
  });
  it('survives JPEG recompression', async () => {
    const text = 'the quick brown fox '.repeat(30);
    const img = encodeCodeArt(await sealText(text, 'pw', MODE_CODEART));
    for (const q of [80, 50]) expect(await openPacket(decodeCodeArt(jpegRoundtrip(img, q)), 'pw')).toBe(text);
  });
  it('survives downscaling plus JPEG', async () => {
    const img = encodeCodeArt(await sealText('abc'.repeat(40), 'pw', MODE_CODEART));
    const out = jpegRoundtrip(scale(img, 0.6), 70);
    expect(await openPacket(decodeCodeArt(out), 'pw')).toBe('abc'.repeat(40));
  });
  it('rejects non-code images', () => {
    const noise = { width: 200, height: 200, data: new Uint8ClampedArray(rnd(200 * 200 * 4, 9)) };
    expect(() => decodeCodeArt(noise)).toThrow();
  });
});

describe('microdot', () => {
  it.each([1, 2, 3, 7, 31, 255, MAX_MICRODOT_PACKET])('recovers all %i bytes from an opaque pixel-packed stamp', (length) => {
    const packet = rnd(length);
    const image = encodeMicrodot(packet);
    expect(decodeMicrodot(image)).toEqual(packet);
    expect(image.width).toBeLessThanOrEqual(19);
    expect(image.height).toBeLessThanOrEqual(18);
    expect(image.data.every((value, i) => i % 4 !== 3 || value === 255)).toBe(true);
  });

  it('preserves all 256 channel values without losing bytes to alpha premultiplication', () => {
    const packet = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeMicrodot(encodeMicrodot(packet))).toEqual(packet);
  });

  it('still reads existing greyscale microdots', () => {
    // Frozen pixels from the original three-pixel greyscale renderer.
    const pixels = 'eJztmVuuwyAMRLvJbLKb5KofqazcTDsjbCDpHAkJIZeH6xekNWOMMcYYY8xoHo/Hu/3yeA+rncU6vO54JnHubdve/efzeUv5bOJ/9Fp/b6/193Yn+SpWs5Mr2OExPsQ9qH1mn7Pnr84pPY3xl9Xmr9BhW8BOqucfnZevpp/e+TO4k5+q82eysp2saodsfLi6fvY6Z0RO+SZzRT+N9fYsHTbboUSs7dE6UQbJq/2seZh+JYzNRxkkr7aseZg2So87tkOO439Uvf/Z/eqc8mutQodtATup7o+IjereYl1RcXY1TjL7qUT1hVjfVviamq+Z/YzSo9K3HX6Oh0e5s756RrUuQu/5jPzZ/qtzCpo/y9fU+hx9V2Lk1TNm6bDZDlPoiXVRntFPlGfWYr7lMTZQiZrjkDzjp1GeWYv5pszEolF63LEdcnyKh2hdRj+RnnojK/bOyMtoLcZPIz11L8q5zJ7VfWbpsNkOU0D7RONIP8w7JJJXax7mt6jmyQbZPxpHfsq8hyN5tfZmfotq70o9xnN+G7cd/o8PzL0A7fk475mMetdg6iUkf7ZWdU5h7qfId3rmZOQZP1Xr9godNtthCmg/ESbOMPpB6zLyzP87A+QXESbfMX6K1mXkmTgzE9uhzjE+MPcINdZFmDOimIZiI+JsD9U5hclfas6NML6GcivK0cy5mPEebIe1IH2ic6lzIp0wumL+68jsOBkb8i91TuSbjM+qNfPMfG075PgUD9V3v4zvbkcZJiYz/Tg2Ki+r982s77+o3mb2rNYVFTpstsMUUCxS3xl6aiSmr35DHAXKiep7l+pTzFrqm9joOjBiO9Rh46F6H2G+vzPvCep/+m0/s/Kyei9m3pOZdy01tqg1Q4UOm+0wHSa+MfcUdEY1pqG11Dg5CibPMvdl5GtqbkVrqfl6NLZDDvVOdNfxHlY7i3V43XFjjDHGGGPMGP4ABNzdsQ==';
    const image = { width: 81, height: 81, data: new Uint8ClampedArray(inflateSync(Buffer.from(pixels, 'base64'))) };
    expect(decodeCodeArt(image)).toEqual(buildPart(new Uint8Array(6), 0, 2, Uint8Array.from({ length: 32 }, (_, i) => i)));
  });

  it('rejects altered framing, missing pixels, alpha changes and resized images', () => {
    const image = encodeMicrodot(rnd(31));
    for (const [offset, value] of [[0, 255], [3, 254], [image.data.length - 2, 0]]) {
      const data = image.data.slice();
      data[offset] = value;
      expect(() => decodeMicrodot({ ...image, data })).toThrow(/microdot/);
    }
    expect(() => decodeMicrodot({ ...image, data: image.data.slice(4) })).toThrow(/microdot/);
    expect(() => decodeMicrodot(scale(image, 2))).toThrow(/microdot/);
  });

  it('detects changed encrypted pixels through the existing frame checksum', async () => {
    const image = encodeMicrodot(await sealText('exact pixels only', 'pw', MODE_MICRODOT));
    image.data[12] ^= 1;
    expect(() => parseFrame(decodeMicrodot(image))).toThrow(/checksum/);
  });

  it('unlocks encrypted text with the recipient passcode and rejects a wrong code', async () => {
    const payload = { kind: 'text', text: 'A tiny private note' } as const;
    const packet = await sealPayload(payload, 'generated passphrase', MODE_MICRODOT, undefined, 0, 0, 'recipient code');
    const decoded = decodeMicrodot(encodeMicrodot(packet));
    expect(parsePacket(decoded).mode).toBe(MODE_MICRODOT);
    expect(await openPayload(decoded, 'recipient code')).toMatchObject(payload);
    await expect(openPayload(decoded, 'wrong code')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('splits a public-key encrypted file across compact stamps and restores it in any order', async () => {
    const pair = await generateKeyPair('x25519');
    const recipient = await importIdentity(pair.type, pair.raw, pair.pkcs8);
    const payload = { kind: 'file', name: 'tiny.bin', data: rnd(1600) } as const;
    const packet = await sealPayload(payload, '', MODE_MICRODOT, undefined, 0, 0, '', 0, [recipient]);
    const frames = splitPacket(packet, MAX_MICRODOT_PACKET).map((part) => decodeMicrodot(encodeMicrodot(part))).reverse();
    expect(frames.length).toBeGreaterThan(1);
    const assembled = assemble(frames);
    if (assembled.state !== 'complete') throw new Error('incomplete');
    expect(await openPayload(assembled.packet, '', Date.now(), [recipient])).toMatchObject(payload);
  });

  it('refuses empty or oversized stamps rather than creating an unreadable image', () => {
    for (const length of [0, MAX_MICRODOT_PACKET + 1]) expect(() => encodeMicrodot(new Uint8Array(length))).toThrow(/microdot/);
  });
});

describe('stego', () => {
  const cover = (): Rgba => ({ width: 300, height: 200, data: new Uint8ClampedArray(rnd(300 * 200 * 4, 5)) });
  it('roundtrips and keeps the cover nearly identical', async () => {
    const c = cover();
    const p = await sealText('hidden in plain sight', 'pw', MODE_STEGO);
    const out = await embed(c, p, 'pw');
    let maxDiff = 0;
    for (let i = 0; i < c.data.length; i += 4) for (let ch = 0; ch < 3; ch++) maxDiff = Math.max(maxDiff, Math.abs(c.data[i + ch] - out.data[i + ch]));
    expect(maxDiff).toBeLessThanOrEqual(1);
    expect(await openPacket(await extract(out, 'pw'), 'pw')).toBe('hidden in plain sight');
  });
  it('fails with wrong passphrase, too-small cover, and after JPEG', async () => {
    const p = await sealText('x', 'pw', MODE_STEGO);
    const out = await embed(cover(), p, 'pw');
    await expect(extract(out, 'nope')).rejects.toThrow();
    await expect(extract(jpegRoundtrip(out, 90), 'pw')).rejects.toThrow();
    const tiny: Rgba = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
    expect(stegoCapacity(tiny)).toBeLessThan(p.length);
    await expect(embed(tiny, p, 'pw')).rejects.toThrow();
  });
});
