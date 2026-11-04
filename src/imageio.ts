import type { Rgba } from './codeart';
import { decodeHeic, looksLikeHeic } from './heic';

export function rgbaToCanvas(img: Rgba, canvas = document.createElement('canvas')): HTMLCanvasElement {
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas;
}

/** Decodes an image blob to raw pixels, flattened onto opaque white, without colour conversion. HEIC works everywhere. */
export async function blobToRgba(blob: Blob, maxSide = Infinity): Promise<Rgba> {
  let src: CanvasImageSource & { width: number; height: number };
  try {
    src = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  } catch {
    try {
      src = await createImageBitmap(blob);
    } catch {
      if (!(await looksLikeHeic(blob))) throw new Error('Could not read that image file.');
      src = await decodeHeic(blob);
    }
  }
  const f = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * f));
  const h = Math.max(1, Math.round(src.height * f));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if ('close' in src) (src as ImageBitmap).close();
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode PNG'))), 'image/png'));
}

export async function copyImage(canvas: HTMLCanvasElement): Promise<void> {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('Copying images needs https or localhost. Use Download instead.');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(canvas) })]);
}

/**
 * Puts a ready-to-paste message on the clipboard: rich text (all images + the link), plain text,
 * and, when there is just one image, the PNG itself for apps that only take images.
 */
export async function copyMessage(canvases: HTMLCanvasElement | HTMLCanvasElement[], link: string, openLink: string | null = null, credential: 'passphrase' | 'passcode' = 'passphrase'): Promise<void> {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('Copying needs https or localhost. Use Download instead.');
  }
  const list = Array.isArray(canvases) ? canvases : [canvases];
  const blobs = await Promise.all(list.map(canvasToBlob));
  const urls = await Promise.all(
    blobs.map(
      (png) =>
        new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(png);
        }),
    ),
  );
  const many = list.length > 1;
  const what = many ? `the ${list.length} images below, in order` : 'the image below';
  // For email clients that do not show images or run scripts: a link that opens the site with the secret already loaded.
  const direct = openLink ? ` Or open this link, which loads the secret for you: ${openLink}` : '';
  const text = `I sent you a secret. Open ${link} , add ${many ? 'all the images' : 'the image'} there (paste or drop ${many ? 'them' : 'it'}) and enter the ${credential} I gave you separately.${direct}`;
  const html =
    `<p>I sent you a secret. Open <a href="${link}">${link}</a>, add ${what} there (paste or save and drop ${many ? 'them' : 'it'}) and enter the ${credential} I gave you separately.</p>` +
    (openLink ? `<p>Or <a href="${openLink}">open the secret directly</a>: the site loads it for you and you only type the ${credential}.</p>` : '') +
    urls.map((u, i) => `<p><img src="${u}" alt="Secret image ${i + 1} of ${list.length}" width="${Math.min(list[i].width, 480)}"></p>`).join('');
  const item: Record<string, Blob> = {
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([text], { type: 'text/plain' }),
  };
  if (!many) item['image/png'] = blobs[0];
  await navigator.clipboard.write([new ClipboardItem(item)]);
}

export function download(canvas: HTMLCanvasElement, name: string): void {
  canvasToBlob(canvas).then((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

/** A pleasant noisy gradient: the noise hides least-significant-bit changes. */
export function generateCover(w = 1280, h = 848): Rgba {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const hue = Math.floor(Math.random() * 360);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 60% 22%)`);
  g.addColorStop(1, `hsl(${(hue + 70) % 360} 65% 45%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 6; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = (0.2 + Math.random() * 0.4) * w;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `hsla(${(hue + Math.random() * 120) % 360} 80% 65% / 0.35)`);
    rg.addColorStop(1, 'hsla(0 0% 0% / 0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  const d = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d.data[i] += n;
    d.data[i + 1] += n;
    d.data[i + 2] += n;
    d.data[i + 3] = 255;
  }
  return { width: w, height: h, data: d.data };
}
