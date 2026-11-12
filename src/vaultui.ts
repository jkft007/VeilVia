// The Saved secrets tab: lists encrypted images kept on this device, restores them to the Reveal tab, and imports or exports them.
import type { Rgba } from './codeart';
import { blobToRgba, canvasToBlob, rgbaToCanvas } from './imageio';
import { addItems, deleteItem, exportItems, listItems, makeItem, parseExport, putItem, renameItem, VaultError, type VaultItem, type VaultPart } from './vault';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Deps {
  /** Puts these images on the Reveal tab (replacing what is there) and shows it. */
  restore(images: Rgba[]): void;
}
let deps: Deps;

function setStatus(msg: string, error = false) {
  const s = $('saved-status');
  s.textContent = msg;
  s.classList.toggle('error', error);
}

const errText = (e: unknown) => (e instanceof VaultError ? e.message : 'Something went wrong while saving. ' + ((e as Error)?.message ?? ''));

async function toPart(rgba: Rgba): Promise<VaultPart> {
  const blob = await canvasToBlob(rgbaToCanvas(rgba));
  return { width: rgba.width, height: rgba.height, png: new Uint8Array(await blob.arrayBuffer()) };
}
const partBlob = (p: VaultPart) => new Blob([p.png as unknown as BlobPart], { type: 'image/png' });

/** Saves a set of images (one secret, possibly split) to this device. Returns a message for the user. */
export async function saveImages(rgbas: Rgba[], origin: VaultItem['origin']): Promise<string> {
  const parts: VaultPart[] = [];
  for (const r of rgbas) parts.push(await toPart(r));
  const it = await makeItem(parts, origin);
  const added = await addItems([it]);
  void render();
  return added ? `Saved to Saved secrets as "${it.label}". Only the encrypted image${parts.length > 1 ? 's are' : ' is'} kept, never the passphrase.` : 'Already in Saved secrets.';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function button(text: string, onClick: () => void, cls = 'ghost small') {
  const b = el('button', text, cls);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}
function confirmButton(text: string, onConfirm: () => void) {
  const b = button(text, () => {
    if (b.dataset.armed) return onConfirm();
    b.dataset.armed = '1';
    b.textContent = 'Really delete?';
    setTimeout(() => {
      delete b.dataset.armed;
      b.textContent = text;
    }, 4000);
  });
  return b;
}
function downloadBlob(blob: Blob, name: string) {
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fileName = (label: string) => label.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'secret';
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

let items: VaultItem[] = [];

async function render() {
  const box = $('saved-list');
  try {
    items = await listItems();
  } catch (e) {
    box.replaceChildren(el('p', errText(e), 'hint'));
    return;
  }
  const q = $<HTMLInputElement>('saved-filter').value.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  $<HTMLButtonElement>('saved-export').disabled = !items.length;
  $('saved-count').textContent = items.length ? `${items.length} saved` : '';
  box.replaceChildren();
  if (!items.length) {
    box.append(el('p', 'Nothing saved yet. On the Reveal tab, press "Save to Saved secrets" after adding an image, or tick "Also keep the created image" on the Hide tab.', 'hint'));
    return;
  }
  if (!shown.length) {
    box.append(el('p', 'No saved secret matches that search.', 'hint'));
    return;
  }
  for (const it of shown) {
    const card = el('div', '', 'savedcard');
    const img = el('img');
    img.alt = '';
    img.className = 'savedthumb';
    const url = URL.createObjectURL(partBlob(it.parts[0]));
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    const body = el('div', '', 'savedbody');
    const name = el('input');
    name.type = 'text';
    name.value = it.label;
    name.maxLength = 80;
    name.setAttribute('aria-label', 'Name of this saved secret');
    name.onchange = async () => {
      try {
        await putItem(renameItem(it, name.value));
        setStatus('Renamed.');
        void render();
      } catch (e) {
        setStatus(errText(e), true);
      }
    };
    const bytes = it.parts.reduce((n, p) => n + p.png.length, 0);
    const meta = `${it.origin === 'sent' ? 'Created here' : 'Received'} · ${new Date(it.saved).toLocaleString()} · ${it.parts.length} image${it.parts.length > 1 ? 's' : ''} · ${fmtSize(bytes)}`;
    const row = el('div', '', 'row');
    row.append(
      button('Open on Reveal tab', async () => {
        try {
          const rgbas: Rgba[] = [];
          for (const p of it.parts) rgbas.push(await blobToRgba(partBlob(p)));
          deps.restore(rgbas);
        } catch {
          setStatus('That saved image could not be read.', true);
        }
      }, 'primary small'),
      button('Download PNG' + (it.parts.length > 1 ? 's' : ''), async () => {
        for (let i = 0; i < it.parts.length; i++) {
          downloadBlob(partBlob(it.parts[i]), `${fileName(it.label)}${it.parts.length > 1 ? `-part${i + 1}` : ''}.png`);
          if (it.parts.length > 1) await new Promise((r) => setTimeout(r, 350));
        }
      }),
      button('Export', () => downloadBlob(new Blob([exportItems([it])], { type: 'application/json' }), `veilvia-saved-${fileName(it.label)}.json`)),
      confirmButton('Delete', async () => {
        try {
          await deleteItem(it.id);
          setStatus(`Deleted "${it.label}" from this device.`);
        } catch (e) {
          setStatus(errText(e), true);
        }
        void render();
      }),
    );
    body.append(name, el('div', meta, 'hint'), row);
    card.append(img, body);
    box.append(card);
  }
}

async function importText(text: string) {
  try {
    const got = await parseExport(text);
    const added = await addItems(got);
    const dup = got.length - added;
    setStatus(
      got.length === 0 ? 'That export is empty.'
      : added === 0 ? `Nothing new: ${got.length > 1 ? `all ${got.length} were` : 'it was'} already saved here.`
      : `Imported ${added} saved secret${added > 1 ? 's' : ''}${dup ? `; ${dup} ${dup > 1 ? 'were' : 'was'} already saved` : ''}.`,
    );
  } catch (e) {
    setStatus(errText(e), true);
  }
  void render();
}

export function initVaultUi(d: Deps) {
  deps = d;
  $('saved-filter').oninput = () => void render();
  $('saved-export').onclick = () => {
    if (!items.length) return;
    const day = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([exportItems(items)], { type: 'application/json' }), `veilvia-saved-secrets-${day}.json`);
    setStatus(`Exported ${items.length} saved secret${items.length > 1 ? 's' : ''}. The file holds only the encrypted images, not passphrases.`);
  };
  const file = $<HTMLInputElement>('saved-import-file');
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (f.size > 512 * 1024 * 1024) return setStatus('That file is too large to import.', true);
    await importText(await f.text());
  };
  $('tab-saved').addEventListener('click', () => void render());
  void render();
}
