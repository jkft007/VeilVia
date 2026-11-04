import type { Rgba } from './codeart';
import { crc32, MAX_PARTS } from './packet';

const MAGIC = new TextEncoder().encode('VVSheet1');
const MAX_SIDE = 16384;
const MAX_PIXELS = 64 * 1024 * 1024;
const damaged = () => new Error('This image sheet is damaged. Send the original PNG without resizing or conversion.');

/** Lossless clipboard fallback for apps that accept one PNG but ignore HTML images. */
export function encodeImageSheet(images: Rgba[]): Rgba {
  const count = images.length;
  if (count < 2 || count > MAX_PARTS || images.some((im) =>
    !Number.isInteger(im.width) || !Number.isInteger(im.height) || im.width < 1 || im.height < 1 ||
    im.width > MAX_SIDE || im.height > MAX_SIDE || im.data.length !== im.width * im.height * 4)) {
    throw new Error('Cannot combine these images.');
  }
  const header = new Uint8Array(14 + count * 4);
  const view = new DataView(header.buffer);
  const cellWidth = Math.max(Math.ceil(header.length / 3), ...images.map((im) => im.width));
  const cellHeight = Math.max(...images.map((im) => im.height));
  const columns = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * cellHeight / cellWidth))));
  const width = columns * cellWidth;
  const height = 1 + Math.ceil(count / columns) * cellHeight;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error('Too many pixels to copy as one image. Use each part\'s Copy button or download the individual PNGs.');
  }
  header.set(MAGIC);
  header[8] = count;
  header[9] = columns;
  images.forEach((im, i) => {
    view.setUint16(10 + i * 4, im.width);
    view.setUint16(12 + i * 4, im.height);
  });
  view.setUint32(header.length - 4, crc32(header.subarray(0, -4)));
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  header.forEach((byte, i) => { data[Math.floor(i / 3) * 4 + i % 3] = byte; });
  images.forEach((im, i) => {
    const x = (i % columns) * cellWidth;
    const y = 1 + Math.floor(i / columns) * cellHeight;
    for (let row = 0; row < im.height; row++) {
      data.set(im.data.subarray(row * im.width * 4, (row + 1) * im.width * 4), ((y + row) * width + x) * 4);
    }
  });
  return { width, height, data };
}

/** Returns null for ordinary images. Never recurse into sheet contents. */
export function decodeImageSheet(image: Rgba): Rgba[] | null {
  const byte = (i: number) => image.data[Math.floor(i / 3) * 4 + i % 3];
  if (!MAGIC.every((value, i) => byte(i) === value)) return null;
  const count = byte(8);
  const columns = byte(9);
  if (count < 2 || count > MAX_PARTS || columns < 1 || columns > count) throw damaged();
  const header = Uint8Array.from({ length: 14 + count * 4 }, (_, i) => byte(i));
  const view = new DataView(header.buffer);
  if (header.length > image.width * 3 || view.getUint32(header.length - 4) !== crc32(header.subarray(0, -4))) throw damaged();
  const sizes = Array.from({ length: count }, (_, i) => ({
    width: view.getUint16(10 + i * 4), height: view.getUint16(12 + i * 4),
  }));
  const cellWidth = Math.max(Math.ceil(header.length / 3), ...sizes.map((im) => im.width));
  const cellHeight = Math.max(...sizes.map((im) => im.height));
  if (sizes.some((im) => !im.width || !im.height) || image.width !== cellWidth * columns ||
    image.height !== 1 + Math.ceil(count / columns) * cellHeight ||
    image.width > MAX_SIDE || image.height > MAX_SIDE || image.width * image.height > MAX_PIXELS ||
    image.data.length !== image.width * image.height * 4) throw damaged();
  return sizes.map(({ width, height }, i) => {
    const data = new Uint8ClampedArray(width * height * 4);
    const x = (i % columns) * cellWidth;
    const y = 1 + Math.floor(i / columns) * cellHeight;
    for (let row = 0; row < height; row++) {
      const start = ((y + row) * image.width + x) * 4;
      data.set(image.data.subarray(start, start + width * 4), row * width * 4);
    }
    return { width, height, data };
  });
}
