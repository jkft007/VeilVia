// Mode A: packet -> mosaic of 4-colour cells that survives JPEG recompression and rescaling.
//
// Grid is W x W cells (W odd) surrounded by a white quiet zone:
//   ring (row/col 0 and W-1) : alternating dark/light timing cells -> decoder counts them to learn W
//   row 1                    : calibration strip cycling through the 4 palette colours
//   everything else          : 56 header symbols (payload length x7), then Reed-Solomon coded data, then filler
import { decodeBuffer, encodeBuffer, encodedLength } from './ecc';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const PALETTE = [
  [220, 50, 60],
  [245, 200, 40],
  [40, 170, 110],
  [50, 90, 220],
];
const DARK = [24, 24, 40];
const QUIET = 3;
const HEADER_REPS = 7;
const HEADER_SYMBOLS = HEADER_REPS * 8;
const MIN_W = 21;

export const MAX_PACKET = 60000;
export const MAX_MICRODOT_PACKET = 1000;

function dataCapacity(W: number): number {
  return (W - 2) * (W - 3);
}

function neededCells(len: number): number {
  return HEADER_SYMBOLS + encodedLength(len) * 4;
}

export function gridSizeFor(len: number): number {
  const cells = neededCells(len);
  let W = MIN_W;
  while (dataCapacity(W) < cells) W += 2;
  return W;
}

/** Three bytes per opaque RGB pixel, with just one byte recording unused trailing channels. */
export function encodeMicrodot(packet: Uint8Array): Rgba {
  if (!packet.length || packet.length > MAX_MICRODOT_PACKET) throw new Error('A microdot needs 1 to 1000 bytes. Split larger secrets across several images.');
  const pixels = Math.ceil((packet.length + 1) / 3);
  const width = Math.ceil(Math.sqrt(pixels));
  const height = Math.ceil(pixels / width);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  data[0] = width * height * 3 - packet.length - 1;
  for (let i = 0; i < packet.length; i++) {
    const channel = i + 1;
    data[Math.floor(channel / 3) * 4 + channel % 3] = packet[i];
  }
  return { width, height, data };
}

/** Unpacks exact original pixels; callers validate the packet or split-part checksum as usual. */
export function decodeMicrodot(img: Rgba): Uint8Array {
  const { width, height, data } = img;
  const maxSide = Math.ceil(Math.sqrt(Math.ceil((MAX_MICRODOT_PACKET + 1) / 3)));
  const fail = () => { throw new Error('No microdot found. Use the original PNG without resizing or colour changes.'); };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > maxSide || height > maxSide || data.length !== width * height * 4) return fail();
  const length = width * height * 3 - data[0] - 1;
  if (length < 1 || length > MAX_MICRODOT_PACKET) return fail();
  const pixels = Math.ceil((length + 1) / 3);
  if (width !== Math.ceil(Math.sqrt(pixels)) || height !== Math.ceil(pixels / width)) return fail();
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return fail();
  for (let channel = length + 1; channel < width * height * 3; channel++) {
    if (data[Math.floor(channel / 3) * 4 + channel % 3] !== 255) return fail();
  }
  const packet = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const channel = i + 1;
    packet[i] = data[Math.floor(channel / 3) * 4 + channel % 3];
  }
  return packet;
}

export function encodeCodeArt(packet: Uint8Array): Rgba {
  if (packet.length > MAX_PACKET) throw new Error('Message too large for a code image');
  const L = packet.length;
  const symbols: number[] = [];
  for (let r = 0; r < HEADER_REPS; r++) for (let i = 14; i >= 0; i -= 2) symbols.push((L >> i) & 3);
  for (const byte of encodeBuffer(packet)) symbols.push((byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3, byte & 3);

  const W = gridSizeFor(L);
  let lfsr = 0xace1;
  while (symbols.length < dataCapacity(W)) {
    lfsr = (lfsr >> 1) ^ (-(lfsr & 1) & 0xb400);
    symbols.push(lfsr & 3);
  }

  const cell = Math.max(W > 140 ? 6 : 8, Math.ceil(360 / (W + 2 * QUIET)));
  const size = (W + 2 * QUIET) * cell;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);

  const paint = (r: number, c: number, rgb: number[]) => {
    const x0 = (c + QUIET) * cell;
    const y0 = (r + QUIET) * cell;
    for (let y = y0; y < y0 + cell; y++)
      for (let x = x0; x < x0 + cell; x++) {
        const o = (y * size + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
      }
  };

  let s = 0;
  for (let r = 0; r < W; r++)
    for (let c = 0; c < W; c++) {
      const onRing = r === 0 || c === 0 || r === W - 1 || c === W - 1;
      if (onRing) {
        const dark = r === 0 || r === W - 1 ? c % 2 === 0 : r % 2 === 0;
        if (dark) paint(r, c, DARK);
      } else if (r === 1) {
        paint(r, c, PALETTE[(c - 1) % 4]);
      } else {
        paint(r, c, PALETTE[symbols[s++]]);
      }
    }
  return { width: size, height: size, data };
}

// ---- decoding ---------------------------------------------------------------

function isInk(d: Uint8ClampedArray, o: number): boolean {
  const a = d[o + 3] / 255;
  const min = Math.min(d[o], d[o + 1], d[o + 2]);
  return 255 - (min * a + 255 * (1 - a)) > 40;
}

export function findBounds(img: Rgba) {
  const { width, height, data } = img;
  let top = -1, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    let rowHit = false;
    for (let x = 0; x < width; x++) {
      if (isInk(data, (y * width + x) * 4)) {
        rowHit = true;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (rowHit) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) throw new Error('No code found');
  return { top, bottom, left, right };
}

function countDarkRuns(img: Rgba, line: 'row' | 'col', fixed: number, from: number, to: number): number {
  let runs = 0;
  let inDark = false;
  for (let i = from; i <= to; i++) {
    const o = (line === 'row' ? fixed * img.width + i : i * img.width + fixed) * 4;
    const lum = (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3;
    const dark = lum < 140;
    if (dark && !inDark) runs++;
    inDark = dark;
  }
  return runs;
}

export function decodeCodeArt(img: Rgba): Uint8Array {
  const { top, bottom, left, right } = findBounds(img);
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (Math.abs(w - h) > 0.1 * Math.max(w, h) || w < 40) throw new Error('No code found');

  const topRuns = countDarkRuns(img, 'row', Math.min(top + 1, img.height - 1), left, right);
  const leftRuns = countDarkRuns(img, 'col', Math.min(left + 1, img.width - 1), top, bottom);
  let W = 2 * topRuns - 1;
  if (W < MIN_W || W > 600) W = 2 * leftRuns - 1;
  if (W < MIN_W || W > 600) throw new Error('No code found');

  const cs = w / W;
  const csY = h / W;
  const sample = (r: number, c: number): number[] => {
    const cx = left + (c + 0.5) * cs;
    const cy = top + (r + 0.5) * csY;
    const rx = Math.max(0.5, cs * 0.25);
    const ry = Math.max(0.5, csY * 0.25);
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y++)
      for (let x = Math.round(cx - rx); x <= Math.round(cx + rx); x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const o = (y * img.width + x) * 4;
        sr += img.data[o];
        sg += img.data[o + 1];
        sb += img.data[o + 2];
        n++;
      }
    return [sr / n, sg / n, sb / n];
  };

  // Calibrate the 4 colours from the strip in row 1.
  const acc = PALETTE.map(() => [0, 0, 0, 0]);
  for (let c = 1; c < W - 1; c++) {
    const a = acc[(c - 1) % 4];
    const px = sample(1, c);
    a[0] += px[0];
    a[1] += px[1];
    a[2] += px[2];
    a[3]++;
  }
  const ref = acc.map((a) => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);

  const classify = (px: number[]): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = (px[0] - ref[i][0]) ** 2 + (px[1] - ref[i][1]) ** 2 + (px[2] - ref[i][2]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const total = dataCapacity(W);
  const symbols = new Uint8Array(total);
  let s = 0;
  for (let r = 2; r < W - 1; r++) for (let c = 1; c < W - 1; c++) symbols[s++] = classify(sample(r, c));

  // Header: payload length, majority vote over the repeats.
  let L = 0;
  for (let bit = 0; bit < 16; bit++) {
    let ones = 0;
    for (let rep = 0; rep < HEADER_REPS; rep++) {
      const sym = symbols[rep * 8 + (bit >> 1)];
      ones += (sym >> (1 - (bit & 1))) & 1;
    }
    L = (L << 1) | (ones * 2 > HEADER_REPS ? 1 : 0);
  }
  if (L < 1 || L > MAX_PACKET || neededCells(L) > total) throw new Error('No code found');

  const enc = new Uint8Array(encodedLength(L));
  for (let i = 0; i < enc.length; i++) {
    const o = HEADER_SYMBOLS + i * 4;
    enc[i] = (symbols[o] << 6) | (symbols[o + 1] << 4) | (symbols[o + 2] << 2) | symbols[o + 3];
  }
  return decodeBuffer(enc, L);
}
