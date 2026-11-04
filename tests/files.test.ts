import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPacket, openPayload, safeFileName, sealPayload, sealText, WrongPassphraseError } from '../src/crypto';
import { decodeCodeArt, encodeCodeArt, type Rgba } from '../src/codeart';
import { embed, extract, stegoCapacity } from '../src/stego';
import { embedDct, extractDct } from '../src/dct';
import { decodeFakeQr, encodeFakeQr } from '../src/qrmodes';
import { crc32, MODE_CODEART, MODE_DCT, MODE_FAKEQR, MODE_STEGO, parsePacket } from '../src/packet';
import { compressSecretImage } from '../src/imageio';
import { decodeImageSheet, encodeImageSheet } from '../src/imagesheet';

describe('clipboard image sheets', () => {
  const image = (width: number, height: number, value: number): Rgba => ({
    width, height, data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 255 : (i + value) % 256),
  });
  it('preserves every pixel and original dimension of differently sized parts', () => {
    const parts = [image(19, 18, 12), image(33, 41, 59), image(300, 120, 27)];
    expect(decodeImageSheet(encodeImageSheet(parts))).toEqual(parts);
  });
  it('leaves ordinary images alone and rejects damaged or cropped sheet headers', () => {
    expect(decodeImageSheet(image(20, 20, 3))).toBeNull();
    const sheet = encodeImageSheet([image(19, 18, 12), image(16, 17, 7)]);
    expect(() => decodeImageSheet({ ...sheet, height: sheet.height - 1 })).toThrow(/damaged/);
    sheet.data[16] ^= 1;
    expect(() => decodeImageSheet(sheet)).toThrow(/damaged/);
  });
  it('bounds sheet counts and dimensions before allocating pixels', () => {
    const part = image(19, 18, 12);
    expect(() => encodeImageSheet(Array(61).fill(part))).toThrow();
    expect(() => encodeImageSheet([{ ...part, width: 16385 }, part])).toThrow();
  });
});

describe('image compression fallback', () => {
  afterEach(() => vi.unstubAllGlobals());
  const mockImages = () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 50, close() {} }));
    vi.stubGlobal('ImageData', class {});
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          fillRect() {}, drawImage() {}, putImageData() {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        }),
        toBlob(callback: (blob: Blob) => void, type: string, quality: number) {
          callback(new Blob([new Uint8Array(600 + Math.ceil(this.width * this.height * quality))], { type }));
        },
      }),
    });
  };
  it('reduces quality and dimensions until the image meets its byte budget', async () => {
    mockImages();
    const original = new Blob([new Uint8Array(6000)], { type: 'image/png' });
    const compressed = await compressSecretImage(original, 1200);
    expect(compressed?.type).toBe('image/jpeg');
    expect(compressed!.size).toBeLessThanOrEqual(1200);
    expect(original.size).toBe(6000);
  });
  it('reports an impossible budget instead of returning an oversized image', async () => {
    mockImages();
    expect(await compressSecretImage(new Blob([new Uint8Array(6000)]), 100)).toBeNull();
  });
  it('never replaces an image with a larger encoded file', async () => {
    mockImages();
    expect(await compressSecretImage(new Blob([new Uint8Array(100)]), 2000)).toBeNull();
  });
});

const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) out[i] = ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
  return out;
};

const noisyCover = (w: number, h: number): Rgba => {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 5;
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : 100 + 60 * Math.sin(i / 3000) + (((s = (s * 1664525 + 1013904223) >>> 0) >>> 24) % 25);
  return { width: w, height: h, data };
};

describe('safeFileName', () => {
  it('strips paths and unsafe characters', () => {
    expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt');
    expect(safeFileName('bad\u0000name\u001f.doc')).toBe('bad_name_.doc');
    expect(safeFileName('   ...   ')).toBe('secret-file');
    expect(safeFileName('')).toBe('secret-file');
  });
  it('keeps the extension when shortening long names', () => {
    const n = safeFileName('x'.repeat(300) + '.pdf');
    expect(n.length).toBe(120);
    expect(n.endsWith('.pdf')).toBe(true);
  });
});

describe('file payloads', () => {
  it('roundtrips binary data with every byte value, and flags the packet as a file', async () => {
    const data = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
    const p = await sealPayload({ kind: 'file', name: 'données 📄.bin', data }, 'pw', MODE_CODEART);
    expect(parsePacket(p).isFile).toBe(true);
    const out = await openPayload(p, 'pw');
    expect(out.kind).toBe('file');
    if (out.kind === 'file') {
      expect(out.name).toBe('données 📄.bin');
      expect(out.data).toEqual(data);
    }
  });
  it('keeps text packets as text and rejects wrong passphrases', async () => {
    const t = await sealText('plain', 'pw', MODE_CODEART);
    expect(parsePacket(t).isFile).toBe(false);
    expect(await openPacket(t, 'pw')).toBe('plain');
    const f = await sealPayload({ kind: 'file', name: 'a.txt', data: bytes(50) }, 'pw', MODE_CODEART);
    await expect(openPayload(f, 'nope')).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(openPacket(f, 'pw')).rejects.toThrow(/file/);
  });
  it('cannot flip the file flag without breaking authentication', async () => {
    const f = await sealPayload({ kind: 'file', name: 'a.txt', data: bytes(50) }, 'pw', MODE_CODEART);
    f[3] &= ~0x20;
    new DataView(f.buffer).setUint32(f.length - 4, crc32(f.subarray(0, f.length - 4))); // valid CRC: only the GCM tag can catch it now
    expect(() => parsePacket(f)).not.toThrow();
    await expect(openPayload(f, 'pw')).rejects.toThrow();
  });
  it('sanitises a hostile file name inside the payload', async () => {
    const p = await sealPayload({ kind: 'file', name: '..\\..\\evil.exe', data: bytes(10) }, 'pw', MODE_CODEART);
    const out = await openPayload(p, 'pw');
    expect(out.kind === 'file' && out.name).toBe('evil.exe');
  });
});

describe('files through each image style', () => {
  const doc = bytes(6000, 11); // incompressible 6 KB "document"
  const sealed = (mode: number, d = doc) => sealPayload({ kind: 'file', name: 'doc.bin', data: d }, 'pw', mode);
  const check = async (packet: Uint8Array, d = doc) => {
    const out = await openPayload(packet, 'pw');
    expect(out.kind === 'file' && out.data).toEqual(d);
  };

  it('code art', async () => check(decodeCodeArt(encodeCodeArt(await sealed(MODE_CODEART)))));
  it('lossless photo', async () => {
    const out = await embed(noisyCover(500, 400), await sealed(MODE_STEGO), 'pw');
    await check(await extract(out, 'pw'));
  });
  it('JPEG-safe photo', async () => {
    const small = bytes(1500, 3);
    const out = await embedDct(noisyCover(1024, 768), await sealed(MODE_DCT, small), 'pw');
    await check(await extractDct(out, 'pw'), small);
  });
  it('fake QR (small file)', async () => {
    const small = bytes(150, 4);
    const img = await encodeFakeQr(await sealed(MODE_FAKEQR, small), 'https://example.com', 'pw');
    await check(await decodeFakeQr(img, 'pw'), small);
  });
  it('lossless photo capacity is large enough for real documents', () => {
    expect(stegoCapacity(noisyCover(1280, 848))).toBeGreaterThan(300_000);
  });
});
