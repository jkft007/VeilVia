// Plain QR (packet as base64) and fake QR (valid QR for a decoy; real packet hidden in its
// error-correction budget).
import jsQR, { type QRCode } from 'jsqr';
import { PacketError, parseFrame } from './packet';
import { layoutKey, legacyLayoutKey } from './kdf';
import { decodeBuffer, encodedLength, encodeBuffer } from './ecc';
import { findBounds, type Rgba } from './codeart';
import { blockMap, byteCapacity, buildSymbol, encodeQr, encodeQrAt, layout, readCodewords, type QrSymbol } from './qr';

// ---- rendering / reading ----------------------------------------------------

export function qrToRgba(sym: QrSymbol): Rgba {
  const quiet = 4;
  const scale = Math.max(6, Math.ceil(360 / (sym.size + 2 * quiet)));
  const size = (sym.size + 2 * quiet) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  sym.modules.forEach((row, my) =>
    row.forEach((dark, mx) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const o = (((my + quiet) * scale + dy) * size + (mx + quiet) * scale + dx) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
    }),
  );
  return { width: size, height: size, data };
}

type QrLocation = QRCode['location'];

function scan(img: Rgba): QRCode {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (!r) throw new Error('No QR code found');
  return r;
}

/** Samples an axis-aligned QR symbol (white margin around it) into a module matrix. */
function sampleModules(img: Rgba, n: number): boolean[][] {
  const { top, bottom, left, right } = findBounds(img);
  const cw = (right - left + 1) / n;
  const ch = (bottom - top + 1) / n;
  const out: boolean[][] = [];
  for (let y = 0; y < n; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < n; x++) {
      const cx = left + (x + 0.5) * cw;
      const cy = top + (y + 0.5) * ch;
      const rx = Math.max(0.5, cw * 0.25);
      const ry = Math.max(0.5, ch * 0.25);
      let sum = 0;
      let cnt = 0;
      for (let py = Math.round(cy - ry); py <= Math.round(cy + ry); py++)
        for (let px = Math.round(cx - rx); px <= Math.round(cx + rx); px++) {
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
          const o = (py * img.width + px) * 4;
          sum += (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3;
          cnt++;
        }
      row.push(sum / cnt < 128);
    }
    out.push(row);
  }
  return out;
}


type Pt = { x: number; y: number };

/** Solves the 3x3 projective map taking module coordinates to image pixels from 4 point pairs. */
function homography(src: [number, number][], dst: Pt[]): number[] {
  const A: number[][] = [];
  src.forEach(([u, v], i) => {
    const { x, y } = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  });
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]);
}

/** Samples a QR symbol of any orientation/perspective using the locator points jsQR found. */
function sampleModulesProjective(img: Rgba, n: number, loc: QrLocation): boolean[][] {
  const src: [number, number][] = [[3.5, 3.5], [n - 3.5, 3.5], [3.5, n - 3.5]];
  const dst: Pt[] = [loc.topLeftFinderPattern, loc.topRightFinderPattern, loc.bottomLeftFinderPattern];
  if (loc.bottomRightAlignmentPattern) {
    src.push([n - 6.5, n - 6.5]);
    dst.push(loc.bottomRightAlignmentPattern);
  } else {
    src.push([n - 3.5, n - 3.5]);
    dst.push({ x: dst[1].x + dst[2].x - dst[0].x, y: dst[1].y + dst[2].y - dst[0].y });
  }
  const h = homography(src, dst);
  const gray = (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return 255;
    const fx = x - x0;
    const fy = y - y0;
    const g = (xx: number, yy: number) => {
      const o = (yy * img.width + xx) * 4;
      return (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3;
    };
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  const vals: number[][] = [];
  const offs = [-0.22, 0, 0.22];
  for (let my = 0; my < n; my++) {
    const row: number[] = [];
    for (let mx = 0; mx < n; mx++) {
      let sum = 0;
      for (const dy of offs)
        for (const dx of offs) {
          const u = mx + 0.5 + dx;
          const v = my + 0.5 + dy;
          const w = h[6] * u + h[7] * v + 1;
          sum += gray((h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w);
        }
      row.push(sum / 9);
    }
    vals.push(row);
  }
  // 2-means threshold copes with uneven camera exposure
  let t = 128;
  for (let it = 0; it < 12; it++) {
    let lo = 0, nl = 0, hi = 0, nh = 0;
    for (const row of vals) for (const v of row) if (v < t) (lo += v, nl++); else (hi += v, nh++);
    if (!nl || !nh) break;
    t = (lo / nl + hi / nh) / 2;
  }
  return vals.map((row) => row.map((v) => v < t));
}

// ---- plain QR ----------------------------------------------------------------

const toB64 = (u: Uint8Array) => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (u: Uint8Array) => toB64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));

/** Where a scanned plain QR sends the phone: this site, with the encrypted packet in the part after '#'. */
export const SITE_URL = 'https://jkft007.github.io/VeilVia/';
const QR_PARAM = '#q=';

/** The text a plain QR holds: a link that opens the app with the encrypted packet ready to reveal. */
export const packetLink = (packet: Uint8Array, baseUrl = SITE_URL): string => `${baseUrl}${QR_PARAM}${toB64Url(packet)}`;

/** Characters the link adds around the packet, for capacity estimates. */
export const linkOverhead = (baseUrl = SITE_URL): number => baseUrl.length + QR_PARAM.length;

/** The packet in a scanned QR's text: the link form, or the raw base64 that earlier versions made. */
export function packetFromQrText(text: string): Uint8Array {
  const m = /#q=([A-Za-z0-9_-]+)\s*$/.exec(text);
  return m ? fromB64Url(m[1]) : fromB64(text);
}

/**
 * A plain QR code. It holds a link, so an ordinary phone camera opens the app with the secret already loaded
 * (the packet sits in the URL fragment, which browsers never send to a server) and only the passphrase is missing.
 */
export function encodePlainQr(packet: Uint8Array, baseUrl = SITE_URL): Rgba {
  return qrToRgba(encodeQr(new TextEncoder().encode(packetLink(packet, baseUrl)), 'M'));
}

export function decodePlainQr(img: Rgba): Uint8Array {
  return packetFromQrText(scan(img).data);
}

// ---- fake QR -----------------------------------------------------------------

const HIDDEN_HEADER = 6; // payload length, 2 bytes x3 for majority voting

/** Hidden bytes a version can carry: half of what each RS block could correct stays free for noise. */
export function fakeQrCapacity(version: number): number {
  const l = layout(version, 'H');
  return l.nb * (l.eccLen >> 2) - HIDDEN_HEADER;
}

async function hiddenPlan(version: number, passphrase: string, legacy: boolean): Promise<number[]> {
  const l = layout(version, 'H');
  const blocks = blockMap(l);
  const h = legacy ? await legacyLayoutKey(`ST-fakeqr|${version}`, passphrase) : await layoutKey(passphrase, `fakeqr|${version}`);
  const dv = new DataView(h.buffer);
  let a = dv.getUint32(0) | 1;
  let b = dv.getUint32(4);
  let c = dv.getUint32(8);
  let d = dv.getUint32(12);
  const rnd = () => {
    // sfc32
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  const per: number[][] = Array.from({ length: l.nb }, () => []);
  blocks.forEach((blk, idx) => per[blk].push(idx));
  for (const list of per)
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  const budget = l.eccLen >> 2;
  const order: number[] = [];
  for (let r = 0; r < budget; r++) for (let j = 0; j < l.nb; j++) order.push(per[j][r]);
  return order;
}

export async function encodeFakeQr(packet: Uint8Array, decoy: string, passphrase: string, legacy = false): Promise<Rgba> {
  const need = encodedLength(packet.length);
  const decoyBytes = new TextEncoder().encode(decoy);
  let version = 0;
  for (let v = 1; v <= 40; v++)
    if (fakeQrCapacity(v) >= need && byteCapacity(v, 'H') >= decoyBytes.length) {
      version = v;
      break;
    }
  if (!version) throw new Error('Too much data for a fake QR code. Use a smaller secret or a shorter decoy.');

  const clean = encodeQrAt(decoyBytes, 'H', version);
  const plan = await hiddenPlan(version, passphrase, legacy);
  const hidden = new Uint8Array(HIDDEN_HEADER + need);
  for (let r = 0; r < 3; r++) {
    hidden[r * 2] = packet.length >> 8;
    hidden[r * 2 + 1] = packet.length & 255;
  }
  hidden.set(encodeBuffer(packet), HIDDEN_HEADER);
  const cw = clean.codewords.slice();
  hidden.forEach((byte, i) => (cw[plan[i]] ^= byte));
  return qrToRgba(buildSymbol(version, 'H', cw, clean.mask));
}

export async function decodeFakeQr(img: Rgba, passphrase: string, res: QRCode = scan(img), legacy = false): Promise<Uint8Array> {
  const clean = encodeQrAt(Uint8Array.from(res.binaryData), 'H', res.version);
  const plan = await hiddenPlan(res.version, passphrase, legacy);
  const samplers = [() => sampleModulesProjective(img, clean.size, res.location), () => sampleModules(img, clean.size)];
  let lastError: unknown = new Error('No hidden data');
  for (const sample of samplers) {
    try {
      return extractHidden(readCodewords(sample(), res.version, clean.mask), clean.codewords, plan);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function extractHidden(observed: Uint8Array, clean: Uint8Array, plan: number[]): Uint8Array {
  const delta = (i: number) => observed[plan[i]] ^ clean[plan[i]];
  const vote = (k: number) => {
    const [x, y, z] = [delta(k), delta(k + 2), delta(k + 4)];
    return x === y || x === z ? x : y === z ? y : x;
  };
  const len = (vote(0) << 8) | vote(1);
  const need = encodedLength(len);
  if (len < 1 || HIDDEN_HEADER + need > plan.length) throw new Error('No hidden data');
  const enc = new Uint8Array(need);
  for (let i = 0; i < need; i++) enc[i] = delta(HIDDEN_HEADER + i);
  return decodeBuffer(enc, len);
}

export type FrameResult = { kind: 'packet'; packet: Uint8Array } | { kind: 'qr-no-secret' } | { kind: 'none' };

/** One camera frame: a plain-QR packet needs no passphrase; a fake QR needs it for the hidden positions. */
export async function tryDecodeQrFrame(frame: Rgba, passphrase: string): Promise<FrameResult> {
  const res = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
  if (!res) return { kind: 'none' };
  try {
    const p = packetFromQrText(res.data);
    parseFrame(p);
    return { kind: 'packet', packet: p };
  } catch {
    /* not a plain secret QR */
  }
  if (passphrase) {
    try {
      const p = await decodeFakeQr(frame, passphrase, res);
      parseFrame(p);
      return { kind: 'packet', packet: p };
    } catch (e) {
      if (!(e instanceof PacketError) && !(e instanceof Error)) throw e;
    }
  }
  return { kind: 'qr-no-secret' };
}
