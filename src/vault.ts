// Saved secrets: encrypted images ("transport media") kept on this device so they can be revealed again later.
// Only the encrypted images are kept, as lossless PNG files. Passphrases, passcodes and revealed contents are never stored,
// so a saved item is exactly as safe as the image was when it arrived. Items live in IndexedDB; an export is a small JSON
// file holding the same PNG bytes, which can be imported on another device.

export class VaultError extends Error {}

export interface VaultPart {
  width: number;
  height: number;
  png: Uint8Array; // the image, exactly as lossless PNG
}

export interface VaultItem {
  id: string; // from a hash of the parts, so the same image set is only kept once
  label: string;
  origin: 'received' | 'sent';
  saved: number; // when it was saved (ms since 1970)
  parts: VaultPart[];
}

export const EXPORT_FORMAT = 'veilvia-saved-secrets';
export const MAX_LABEL = 80;
export const MAX_ITEM_PARTS = 64;
const MAX_PART_BYTES = 40 * 1024 * 1024;
const MAX_IMPORT_ITEMS = 5000;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (b: Uint8Array) => b.length > 24 && PNG_SIG.every((v, i) => b[i] === v);
const cleanLabel = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LABEL);

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

/** The id of a set of images: a hash of their PNG bytes, in order. */
export async function itemId(parts: VaultPart[]): Promise<string> {
  const total = parts.reduce((n, p) => n + p.png.length + 4, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    new DataView(all.buffer).setUint32(o, p.png.length);
    all.set(p.png, o + 4);
    o += p.png.length + 4;
  }
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Makes a new item from lossless PNG images. */
export async function makeItem(parts: VaultPart[], origin: VaultItem['origin'], label = '', now = Date.now()): Promise<VaultItem> {
  if (!parts.length) throw new VaultError('There is no image to save.');
  if (parts.length > MAX_ITEM_PARTS) throw new VaultError(`At most ${MAX_ITEM_PARTS} images can be saved together.`);
  for (const p of parts) if (!isPng(p.png)) throw new VaultError('Only PNG images can be saved.');
  const n = parts.length;
  const fallback = `${origin === 'sent' ? 'Sent' : 'Received'} ${new Date(now).toLocaleString()}${n > 1 ? ` (${n} images)` : ''}`;
  return { id: await itemId(parts), label: cleanLabel(label) || fallback, origin, saved: now, parts };
}

/** A JSON export of the given items. It holds only the encrypted images and their names. */
export function exportItems(items: VaultItem[], now = Date.now()): string {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    exported: new Date(now).toISOString(),
    items: items.map((it) => ({ label: it.label, origin: it.origin, saved: it.saved, parts: it.parts.map((p) => ({ width: p.width, height: p.height, png: b64(p.png) })) })),
  });
}

/** Reads an export made by exportItems. Ids are worked out again from the images, never taken from the file. */
export async function parseExport(text: string): Promise<VaultItem[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new VaultError('That is not a saved-secrets export (it is not JSON).');
  }
  const d = doc as { format?: unknown; version?: unknown; items?: unknown };
  if (!d || d.format !== EXPORT_FORMAT) throw new VaultError('That is not a saved-secrets export.');
  if (d.version !== 1) throw new VaultError('That export was made by a newer version of this app.');
  if (!Array.isArray(d.items) || d.items.length > MAX_IMPORT_ITEMS) throw new VaultError('That export is damaged.');
  const out: VaultItem[] = [];
  for (const raw of d.items as unknown[]) {
    const r = raw as { label?: unknown; origin?: unknown; saved?: unknown; parts?: unknown };
    if (!r || !Array.isArray(r.parts) || !r.parts.length || r.parts.length > MAX_ITEM_PARTS) throw new VaultError('That export is damaged.');
    const parts: VaultPart[] = [];
    for (const pr of r.parts as unknown[]) {
      const p = pr as { width?: unknown; height?: unknown; png?: unknown };
      const w = Number(p?.width);
      const h = Number(p?.height);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 20000 || h > 20000 || typeof p.png !== 'string' || p.png.length > (MAX_PART_BYTES * 4) / 3 + 4) {
        throw new VaultError('That export is damaged.');
      }
      let png: Uint8Array;
      try {
        png = unb64(p.png);
      } catch {
        throw new VaultError('That export is damaged.');
      }
      if (!isPng(png)) throw new VaultError('That export holds something other than PNG images.');
      parts.push({ width: w, height: h, png });
    }
    const saved = Number(r.saved);
    const it = await makeItem(parts, r.origin === 'sent' ? 'sent' : 'received', typeof r.label === 'string' ? r.label : '', Number.isFinite(saved) && saved > 0 ? saved : Date.now());
    out.push(it);
  }
  return out;
}

export const renameItem = (it: VaultItem, label: string): VaultItem => ({ ...it, label: cleanLabel(label) || it.label });

// ---- storage (IndexedDB) ---------------------------------------------------------------
const DB_NAME = 'veilvia-saved-secrets';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new VaultError('This browser cannot save secrets here (private browsing can block it).'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new VaultError('This browser would not open its storage (private browsing can block it).'));
  });
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('items', mode);
      const req = f(tx.objectStore('items'));
      tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
      const fail = () => reject(new VaultError(tx.error?.name === 'QuotaExceededError' ? 'There is no room left in this browser\'s storage. Delete or export some saved secrets.' : 'The browser refused to store that.'));
      tx.onerror = fail;
      tx.onabort = fail;
    });
  } finally {
    db.close();
  }
}

export const listItems = (): Promise<VaultItem[]> => run<VaultItem[]>('readonly', (s) => s.getAll()).then((a) => a.sort((x, y) => y.saved - x.saved));
export const getItem = (id: string): Promise<VaultItem | undefined> => run<VaultItem | undefined>('readonly', (s) => s.get(id));
export const putItem = (it: VaultItem): Promise<unknown> => run('readwrite', (s) => s.put(it));
export const deleteItem = (id: string): Promise<unknown> => run('readwrite', (s) => s.delete(id));

/** Saves items that are not already stored (by id). Returns how many were new. */
export async function addItems(items: VaultItem[]): Promise<number> {
  const have = new Set((await listItems()).map((i) => i.id));
  const fresh = items.filter((i) => !have.has(i.id) && (have.add(i.id), true));
  if (fresh.length) await run('readwrite', (s) => void fresh.forEach((i) => s.put(i)));
  return fresh.length;
}
