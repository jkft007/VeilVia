import { decodeCodeArt, decodeMicrodot, encodeCodeArt, encodeMicrodot, MAX_MICRODOT_PACKET, MAX_PACKET, type Rgba } from './codeart';
import { cropTo8, extractDct, MAX_COVER_SIDE } from './dct';
import { MAX_MESSAGES } from './lanes';
import { findPhoto, hidePhoto, photoCapacity, photoLayout, type PhotoMessage } from './photo';
import { decodeFakeQr, decodePlainQr, encodeFakeQr, encodePlainQr, linkOverhead, packetFromQrText, packetLink } from './qrmodes';
import { ExpiredError, NEVER_CLEAR, openPayload, sealPayload, WrongPassphraseError, type Payload } from './crypto';
import { encodedLength } from './ecc';
import { byteCapacity } from './qr';
import { fakeQrCapacity } from './qrmodes';
import { MAX_PARTS, MODE_CODEART, MODE_DCT, MODE_FAKEQR, MODE_MICRODOT, MODE_QR, MODE_STEGO, PART_OVERHEAD, parseFrame, parsePacket } from './packet';
import { assemble, splitPacket } from './split';
import { extract } from './stego';
import { blobToRgba, compressSecretImage, copyImage, copyMessage, download, generateCover, rgbaToCanvas } from './imageio';
import { idToStyle, NO_ANIM, styleToId, STYLES } from './reveal-styles';
import type { RevealHandle } from './reveal-anim';
import { startScanner, type Scanner } from './camera';
import { startPreview, type Preview } from './capture';
import { readText } from './ocr';
import { strength } from './strength';
import { checkLock, defaultStore, fingerprint, recordFailure, recordSuccess } from './throttle';
import { getExpectedSender, getRecipients, getSigner, handleToHash, hasStoredKeys, initKeysUi, passphraseViaPasskey, storedPublicKeys } from './keysui';
import { listContacts, unlockAll } from './keystore';
import { senderStatus } from './signing';
import { poofCanvas, wallyPeek } from './poof';
import { localVoices, speak, speechAvailable, stopSpeaking } from './speech';
import { PasskeyError } from './passkey';
import { photoPassFor } from './pubkey';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || $<HTMLInputElement>('chk-motion').checked;

function setStatus(el: HTMLElement, msg: string, error = false) {
  el.textContent = msg;
  el.classList.toggle('error', error);
}

const simpleSend = () => document.body.classList.contains('simple-send');
function setExperience(simple: boolean) {
  document.body.classList.toggle('simple-send', simple);
  $('experience-toggle').textContent = simple ? 'Advanced user' : 'Simple sending';
  $('experience-toggle').setAttribute('aria-pressed', String(!simple));
  $('btn-create').textContent = simple ? 'Create image & copy' : 'Create image';
  syncModeUi();
}
$('experience-toggle').onclick = () => {
  setExperience(!simpleSend());
  showTab('hide');
};

// ---- tabs -------------------------------------------------------------------
function showTab(which: 'hide' | 'reveal' | 'read' | 'keys') {
  if (which === 'read') {
    $('tab-read').hidden = false;
    $('tab-read').parentElement!.classList.add('has-reading');
  }
  for (const t of ['hide', 'reveal', 'read', 'keys'] as const) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === which));
    $(`panel-${t}`).hidden = t !== which;
  }
}
$('tab-hide').onclick = () => showTab('hide');
$('tab-reveal').onclick = () => showTab('reveal');
$('tab-read').onclick = () => showTab('read');
$('btn-read-another').onclick = () => {
  showTab('reveal');
  $<HTMLInputElement>('pass2').focus();
};
$('tab-keys').onclick = () => showTab('keys');

// ---- passphrase helpers -----------------------------------------------------
let generatedPass = ''; // a passphrase made by the Generate button is known to be random

function passStrength() {
  const v = $<HTMLInputElement>('pass').value;
  return strength(v, v !== '' && v === generatedPass);
}

function updateMeter() {
  const { bits, level } = passStrength();
  const m = $('pass-meter');
  m.style.width = `${Math.min(100, (bits / 80) * 100)}%`;
  m.style.background = level === 'ok' ? 'var(--signal-violet)' : level === 'strong' ? 'var(--verified)' : 'var(--critical)';
  $('pass-note').textContent =
    level === 'none'
      ? ''
      : level === 'weak'
        ? 'Too easy to guess. Anyone who copies the image can try guesses offline, so use a longer one (press Generate for a strong one).'
        : level === 'ok'
          ? 'Acceptable, but longer is better.'
          : 'Strong.';
  $('weak-row').hidden = level !== 'weak';
  if (level !== 'weak') $<HTMLInputElement>('chk-weak').checked = false;
}
$('pass').addEventListener('input', updateMeter);
$('simple-passcode').addEventListener('input', () => {
  const { bits, level } = strength($<HTMLInputElement>('simple-passcode').value);
  const score = Math.min(100, (bits / 80) * 100);
  const meter = $('simple-code-meter');
  meter.style.width = `${score}%`;
  meter.style.background = level === 'ok' ? 'var(--signal-violet)' : level === 'strong' ? 'var(--verified)' : 'var(--critical)';
  $('simple-code-strength').setAttribute('aria-valuenow', String(score));
  $('simple-code-strength').setAttribute('aria-valuetext', level === 'none' ? 'Not entered' : level);
  $('simple-code-note').textContent = level === 'none' ? '' : level === 'weak'
    ? 'Too easy to guess. Use at least five unrelated words, or explicitly accept the risk below. A short passcode can be guessed offline.'
    : level === 'ok' ? 'Acceptable; longer is better.' : 'Strong.';
  $('simple-weak-row').hidden = level !== 'weak';
  if (level !== 'weak') $<HTMLInputElement>('chk-simple-weak-code').checked = false;
});

// The optional recipient passcode gets the same strength check: it opens the image just like the passphrase does.
$('passcode').addEventListener('input', () => {
  const { level } = strength($<HTMLInputElement>('passcode').value);
  $('code-note').textContent =
    level === 'none' ? '' : level === 'weak' ? 'Too easy to guess. Anyone who copies the image can try guesses offline, so make it longer.' : level === 'ok' ? 'Acceptable, but longer is better.' : 'Strong.';
  $('weak-code-row').hidden = level !== 'weak';
  if (level !== 'weak') $<HTMLInputElement>('chk-weak-code').checked = false;
});

// The collapsed "More options" box says which of its settings are not at their defaults.
function updateOptSummary() {
  const text = (id: string) => {
    const s = $<HTMLSelectElement>(id);
    return s.options[s.selectedIndex]?.textContent ?? '';
  };
  const parts: string[] = [];
  if ($<HTMLInputElement>('chk-nonsense').checked) parts.push('no animation');
  else if ($<HTMLSelectElement>('anim-pick').value !== 'auto') parts.push(text('anim-pick'));
  if ($<HTMLSelectElement>('read-time').value !== '60') parts.push(`reading ${text('read-time').toLowerCase()}`);
  if ($<HTMLInputElement>('chk-lock-read-time').checked) parts.push('reading time locked');
  if ($<HTMLSelectElement>('expiry').value !== '0') parts.push(`expires ${text('expiry').toLowerCase()}`);
  if ($<HTMLInputElement>('passcode').value) parts.push('passcode');
  $('opt-summary').textContent = parts.length ? `(${parts.join(' · ')})` : '(defaults)';
}
for (const id of ['anim-pick', 'read-time', 'expiry', 'passcode', 'chk-lock-read-time']) $(id).addEventListener('input', updateOptSummary);
for (const id of ['anim-pick', 'read-time', 'expiry', 'passcode', 'chk-lock-read-time']) $(id).addEventListener('change', updateOptSummary);
// "No nonsense": the secret is shown at once, with no animation, and the animation menu is not used.
for (const ev of ['change', 'input']) {
  $('chk-nonsense').addEventListener(ev, () => {
    $<HTMLSelectElement>('anim-pick').disabled = $<HTMLInputElement>('chk-nonsense').checked;
    updateOptSummary();
  });
}

// The sender's animation list mirrors the reveal list; "auto" there means the recipient's browser picks one.
{
  const dst = $<HTMLSelectElement>('anim-pick');
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Random';
  dst.append(auto);
  for (const o of $<HTMLSelectElement>('anim-style').options) {
    if (o.value !== 'auto') dst.append(new Option(o.textContent ?? o.value, o.value));
    $('read-anim-style').append(new Option(o.textContent ?? o.value, o.value));
  }
}
for (const [from, to] of [['anim-style', 'read-anim-style'], ['read-anim-style', 'anim-style']]) {
  $(from).addEventListener('change', () => {
    $<HTMLSelectElement>(to).value = $<HTMLSelectElement>(from).value;
  });
}
for (const [from, to] of [['chk-motion', 'chk-read-motion'], ['chk-read-motion', 'chk-motion']]) {
  $(from).addEventListener('change', () => {
    $<HTMLInputElement>(to).checked = $<HTMLInputElement>(from).checked;
  });
}

$('pass-toggle').onclick = () => {
  const i = $<HTMLInputElement>('pass');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('pass-toggle').textContent = i.type === 'password' ? 'Show' : 'Hide';
};

function randomPassphrase() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

$('pass-gen').onclick = () => {
  const i = $<HTMLInputElement>('pass');
  i.value = randomPassphrase();
  generatedPass = i.value;
  i.type = 'text';
  $('pass-toggle').textContent = 'Hide';
  updateMeter();
};

// ---- hide -------------------------------------------------------------------
type Mode = 'codeart' | 'qr' | 'fakeqr' | 'photo' | 'microdot';
const currentMode = () => $<HTMLSelectElement>('mode').value as Mode;
const MODE_HELP: Record<Mode, string> = {
  codeart: 'A colourful mosaic. Survives JPEG compression, resizing and screenshots, so it works in nearly every app. Obviously not a normal picture.',
  qr: 'A standard QR code holding a link to this page with the encrypted data inside it. Scanning it with any phone camera opens the page with the secret loaded, ready for the passphrase. Best for short secrets.',
  fakeqr: 'Scans as a harmless decoy of your choice (like a web link). The real secret is hidden inside the QR image itself.',
  photo: 'Looks like an ordinary picture.',
  microdot: 'An ultra-small colour stamp: three encrypted bytes per pixel, at most 19 by 18 pixels per image. No border or error correction. Keep the exact original PNG: resizing, colour changes or JPEG conversion break it. Reveal by uploading or pasting, not QR scanning.',
};
const photoKind = () => $<HTMLSelectElement>('photo-kind').value as 'dct' | 'lsb';
// ---- what to hide: text or a file ----------------------------------------------
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RISKY_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|jar|lnk|hta|dll|app|sh|apk|pif|reg)$/i;
const fmt = (n: number) => (n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const kindRadios = () => document.querySelectorAll<HTMLInputElement>('input[name=kind]');
const currentKind = () => ([...kindRadios()].find((r) => r.checked)!.value as 'text' | 'file' | 'image');

/** This page's address without any fragment: what a plain QR's link points at. */
const siteBase = () => location.origin + location.pathname;

/** Largest frame (bytes) a single image of the chosen style can carry. */
function frameCapacity(cover?: Rgba): number {
  const m = currentMode();
  if (m === 'codeart') return 3000; // keeps images a sensible size; larger secrets are split
  if (m === 'microdot') return MAX_MICRODOT_PACKET;
  if (m === 'qr') return Math.floor((byteCapacity(30, 'M') - linkOverhead(siteBase())) / 4) * 3; // the link wraps base64, which expands by 4/3
  if (m === 'fakeqr') {
    let lo = 0;
    let hi = 5000;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (encodedLength(mid) <= fakeQrCapacity(30)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  const c = cover ?? { width: 1280, height: 848, data: new Uint8ClampedArray(0) };
  return photoCapacity(simpleSend() ? 'dct' : photoKind(), c, currentPhotoLayout());
}

const FRAMING = 70; // packet header, tag and file name

function syncKindUi() {
  const file = currentKind() !== 'text';
  const image = currentKind() === 'image';
  $('text-row').hidden = file;
  $('file-row').hidden = !file;
  $<HTMLInputElement>('secret-file').accept = image ? 'image/*,.heic,.heif' : '';
  $('secret-file-label').textContent = image ? 'Image to hide' : 'File to hide';
  const hint = $('limit-hint');
  hint.hidden = !file;
  if (file) {
    const m = currentMode();
    const one = Math.max(0, frameCapacity() - FRAMING);
    const all = Math.max(0, (frameCapacity() - PART_OVERHEAD) * MAX_PARTS - FRAMING);
    hint.textContent =
      `One image holds about ${fmt(one)}` +
      (m === 'photo' ? ' with the default cover (a larger cover photo holds more)' : '') +
      ($<HTMLInputElement>('chk-split').checked ? `; bigger files are split across up to ${MAX_PARTS} images (about ${fmt(all)} in all). ` : '. ') +
      'Files that compress well fit more.';
  }
}

// A pasted image can be the secret itself; preserve its bytes unless it needs shrinking to fit.
let pastedSecret: { name: string; data: Uint8Array } | null = null;
const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const extForType = (t: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/heic': 'heic' } as Record<string, string>)[t] ?? 'img';

function syncFileInfo() {
  const f = $<HTMLInputElement>('secret-file').files?.[0];
  const name = pastedSecret?.name ?? f?.name;
  const size = pastedSecret?.data.length ?? f?.size;
  $('file-info').textContent = name ? `${name} · ${fmt(size!)}${pastedSecret ? ' (pasted image)' : ''}` : '';
  const w = $('file-warn');
  w.hidden = !(name && RISKY_EXT.test(name));
  w.textContent = 'This is an executable-type file. Your recipient should only open it if they trust you.';
}

async function setSecretImage(blob: Blob) {
  if (!blob.type.startsWith('image/')) return setStatus($('hide-status'), 'That is not an image.', true);
  pastedSecret = { name: `pasted-image.${extForType(blob.type)}`, data: new Uint8Array(await blob.arrayBuffer()) };
  $<HTMLInputElement>('secret-file').value = '';
  syncFileInfo();
  setStatus($('hide-status'), 'Image pasted. Its original bytes will be kept unless it needs compression to fit.');
}

$('btn-paste-secret').onclick = async () => {
  const status = $('hide-status');
  try {
    if (!navigator.clipboard?.read) throw new Error('unsupported');
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return void (await setSecretImage(await item.getType(type)));
    }
    setStatus(status, 'No image found on the clipboard. Copy a picture first, then try again.', true);
  } catch (e) {
    const denied = (e as Error).name === 'NotAllowedError';
    setStatus(status, denied ? 'Clipboard access was blocked. Allow it in the browser, or press Ctrl/Cmd+V instead.' : 'This browser cannot read the clipboard here (needs https or localhost). Press Ctrl/Cmd+V instead.', true);
  }
};

kindRadios().forEach((r) => r.addEventListener('change', syncKindUi));
$('secret-file').addEventListener('change', () => {
  pastedSecret = null; // choosing a file replaces a pasted image
  syncFileInfo();
});
$('photo-kind').addEventListener('change', syncKindUi);

// ---- extra messages in one photo, each with its own passphrase and optional passcode -------
type ExtraRow = { text: string; pass: string; passcode: string; weakOk: boolean };

function readExtras(): ExtraRow[] {
  return [...$('extra-msgs').children].map((r) => ({
    text: r.querySelector('textarea')!.value,
    pass: r.querySelector<HTMLInputElement>('.x-pass')!.value,
    passcode: r.querySelector<HTMLInputElement>('.x-code')!.value,
    weakOk: r.querySelector<HTMLInputElement>('.x-weak')!.checked,
  }));
}

let pkPhotoCount = 0; // messages in a photo sent to public keys (one per way in), while it is being made
function currentPhotoLayout() {
  if (currentMode() !== 'photo') return { nMsg: 1, nLoc: 0 };
  if (simpleSend()) return { nMsg: 1, nLoc: 1 };
  if (pkPhotoCount > 0) return photoLayout(Array.from({ length: pkPhotoCount }, () => ({})));
  return photoLayout([{ passcode: $<HTMLInputElement>('passcode').value }, ...readExtras()]);
}

function syncExtras() {
  const n = $('extra-msgs').children.length;
  $('multi-summary').textContent = n ? `(${n} extra)` : '(optional)';
  $<HTMLButtonElement>('btn-add-msg').hidden = n >= MAX_MESSAGES - 1;
  syncKindUi();
}

$('btn-add-msg').onclick = () => {
  const row = document.createElement('div');
  row.className = 'extra';
  row.innerHTML =
    '<textarea rows="2" spellcheck="false" placeholder="Another secret message"></textarea>' +
    '<div class="row"><input class="x-pass" type="password" autocomplete="off" spellcheck="false" placeholder="Its own passphrase" />' +
    '<input class="x-code" type="password" autocomplete="off" spellcheck="false" placeholder="Passcode (optional)" />' +
    '<button type="button" class="ghost small x-gen">Generate</button><button type="button" class="ghost small x-del">Remove</button></div>' +
    '<label class="check x-weak-row" hidden><input class="x-weak" type="checkbox" /> Use this weak passphrase or passcode anyway</label>';
  row.querySelector<HTMLButtonElement>('.x-gen')!.onclick = () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const chars = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => alphabet[b % alphabet.length]).join('');
    const i = row.querySelector<HTMLInputElement>('.x-pass')!;
    i.value = chars.match(/.{4}/g)!.join('-');
    i.type = 'text'; // shown once so it can be copied and passed on
  };
  row.querySelector<HTMLButtonElement>('.x-del')!.onclick = () => {
    row.remove();
    syncExtras();
  };
  row.addEventListener('input', () => {
    const weak = ['.x-pass', '.x-code'].some((q) => {
      const v = row.querySelector<HTMLInputElement>(q)!.value;
      return v !== '' && strength(v).level === 'weak';
    });
    row.querySelector<HTMLElement>('.x-weak-row')!.hidden = !weak;
    syncKindUi();
  });
  $('extra-msgs').append(row);
  syncExtras();
  row.querySelector('textarea')!.focus();
};
$('passcode').addEventListener('input', syncKindUi);

function syncModeUi() {
  const m = currentMode();
  $('multi').hidden = m !== 'photo';
  $('decoy-row').hidden = m !== 'fakeqr';
  $('photo-opts').hidden = m !== 'photo';
  $('cover-row').hidden = m !== 'photo';
  $('mode-desc').textContent = MODE_HELP[m];
  syncKindUi();
}
$('mode').addEventListener('change', syncModeUi);

// ---- cover photo: chosen from a file, or pasted from the clipboard ---------------
let pastedCover: Blob | null = null;

function syncCoverInfo() {
  $('cover-info').textContent = pastedCover ? 'Using the pasted image as the cover.' : '';
  $('btn-cover-clear').hidden = !pastedCover;
}

async function setCover(blob: Blob) {
  try {
    await blobToRgba(blob, 64); // make sure it really is a readable image
  } catch {
    return setStatus($('hide-status'), 'Could not read that image.', true);
  }
  pastedCover = blob;
  $<HTMLInputElement>('cover-file').value = '';
  syncCoverInfo();
  setStatus($('hide-status'), 'Cover photo pasted.');
}

$('cover-file').addEventListener('change', () => {
  pastedCover = null; // choosing a file replaces a pasted image
  syncCoverInfo();
});
$('btn-cover-clear').onclick = () => {
  pastedCover = null;
  syncCoverInfo();
};
$('btn-paste-cover').onclick = async () => {
  const status = $('hide-status');
  try {
    if (!navigator.clipboard?.read) throw new Error('unsupported');
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return void (await setCover(await item.getType(type)));
    }
    setStatus(status, 'No image found on the clipboard. Copy a photo first, then try again.', true);
  } catch (e) {
    const denied = (e as Error).name === 'NotAllowedError';
    setStatus(status, denied ? 'Clipboard access was blocked. Allow it in the browser, or press Ctrl/Cmd+V instead.' : 'This browser cannot read the clipboard here (needs https or localhost). Press Ctrl/Cmd+V instead.', true);
  }
};

let outs: HTMLCanvasElement[] = [];
/** A link that opens this site with the one image's encrypted data loaded; set for code art and QR only, and only when short enough for email. */
let openLink: string | null = null;
let outputCredential: 'passphrase' | 'passcode' = 'passphrase';
const MAX_OPEN_LINK = 1900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const partName = (i: number, n: number) => (n > 1 ? `secret-part-${i + 1}-of-${n}.png` : 'secret.png');

async function renderFrame(frame: Uint8Array, mode: Mode, kind: 'dct' | 'lsb', pass: string, cover: Rgba | null, passcode = '', extras: PhotoMessage[] = [], lead?: PhotoMessage[]): Promise<Rgba> {
  if (mode === 'codeart') return encodeCodeArt(frame);
  if (mode === 'microdot') return encodeMicrodot(frame);
  if (mode === 'qr') return encodePlainQr(frame, siteBase());
  if (mode === 'fakeqr') {
    const decoy = $<HTMLInputElement>('decoy').value;
    if (!decoy) throw new Error('Enter the decoy text a scanner should show.');
    return encodeFakeQr(frame, decoy, pass);
  }
  const c = cover ?? generateCover(); // a fresh cover per part unless you chose one
  if (lead) return hidePhoto(kind, c, lead);
  return hidePhoto(kind, c, [{ pass, passcode, packet: frame }, ...extras]);
}

function showOutputs(imgs: Rgba[], packetLen: number) {
  const n = imgs.length;
  const single = n === 1;
  $('out-canvas').hidden = !single;
  $('parts-list').hidden = single;
  $('btn-copy').hidden = !single;
  $('btn-copy-msg').textContent = single ? 'Copy message (image + link)' : `Copy message (all ${n} images + link)`;
  $('btn-download').textContent = single ? 'Download PNG' : `Download all ${n}`;
  const list = $('parts-list');
  list.replaceChildren();
  if (single) {
    outs = [rgbaToCanvas(imgs[0], $<HTMLCanvasElement>('out-canvas'))];
    $('out-info').textContent = `${imgs[0].width} × ${imgs[0].height} px · ${packetLen} bytes of encrypted data`;
    return;
  }
  outs = imgs.map((im) => rgbaToCanvas(im));
  outs.forEach((canvas, i) => {
    const row = document.createElement('div');
    row.className = 'part';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b>Part ${i + 1} of ${n}</b><span class="hint">${imgs[i].width} × ${imgs[i].height} px</span>`;
    const copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      try {
        await copyImage(canvas);
        setStatus($('hide-status'), `Part ${i + 1} copied.`);
      } catch (e) {
        setStatus($('hide-status'), (e as Error).message, true);
      }
    };
    const save = document.createElement('button');
    save.className = 'ghost';
    save.textContent = 'Download';
    save.onclick = () => download(canvas, partName(i, n));
    row.append(canvas, meta, copy, save);
    list.append(row);
  });
  $('out-info').textContent = `${n} images · ${packetLen} bytes of encrypted data in total. Send all of them: the recipient needs every part.`;
}

$('btn-create').onclick = async () => {
  const simple = simpleSend();
  const pass = simple ? randomPassphrase() : $<HTMLInputElement>('pass').value;
  const status = $('hide-status');
  let loadPayload: () => Promise<Payload>;
  let imageSource: Blob | null = null;
  let imageName = '';
  if (currentKind() !== 'text') {
    const f = $<HTMLInputElement>('secret-file').files?.[0];
    if (!pastedSecret && !f) return setStatus(status, 'Choose the file to hide, or paste an image.', true);
    if (currentKind() === 'image' && f && !f.type.startsWith('image/') && !/\.(heic|heif)$/i.test(f.name)) {
      return setStatus(status, 'Choose an image, or select File to hide another kind of file.', true);
    }
    const size = pastedSecret?.data.length ?? f!.size;
    const source = pastedSecret ? new Blob([new Uint8Array(pastedSecret.data)], { type: IMAGE_EXT[pastedSecret.name.split('.').pop()!] ?? 'image/png' }) : f!;
    const name = pastedSecret?.name ?? f!.name;
    if (currentKind() === 'image' || pastedSecret) {
      imageSource = source;
      imageName = name;
    }
    if (size > MAX_FILE_BYTES && !imageSource) return setStatus(status, `That file is too large (${fmt(size)}). The limit is ${fmt(MAX_FILE_BYTES)}.`, true);
    loadPayload = async () => ({ kind: 'file', name, data: new Uint8Array(await source.arrayBuffer()) });
  } else {
    const text = $<HTMLTextAreaElement>('secret').value;
    if (!text) return setStatus(status, 'Enter some text to hide.', true);
    loadPayload = async () => ({ kind: 'text', text });
  }
  const recips = simple ? [] : await getRecipients();
  if (!pass && !recips.length) return setStatus(status, 'Enter a passphrase (or press Generate), or add a public key to send to.', true);
  if (!simple && passStrength().level === 'weak' && !$<HTMLInputElement>('chk-weak').checked) {
    return setStatus(status, 'That passphrase is too easy to guess. Press Generate for a strong one, make it longer, or tick "Use it anyway".', true);
  }

  const passcode = $<HTMLInputElement>(simple ? 'simple-passcode' : 'passcode').value;
  if (simple && !passcode) return setStatus(status, 'Enter a passcode to share separately with your recipient.', true);
  if (simple && strength(passcode).level === 'weak' && !$<HTMLInputElement>('chk-simple-weak-code').checked) {
    return setStatus(status, 'That passcode is too easy to guess. Use at least five unrelated words, or tick "Use this short or weak passcode anyway" to accept the risk.', true);
  }
  if (!simple && passcode && strength(passcode).level === 'weak' && !$<HTMLInputElement>('chk-weak-code').checked) {
    $<HTMLDetailsElement>('more-opts').open = true; // the weak-pass-code tick box lives in there
    return setStatus(status, 'That passcode is too easy to guess. Make it longer, or tick "Use this weak passcode anyway".', true);
  }

  // Advanced fake QR uses the main passphrase for positions. Simple sending uses the passcode for positions and its key slot.
  if (!simple && passcode && currentMode() === 'fakeqr') {
    $<HTMLDetailsElement>('more-opts').open = true;
    return setStatus(status, 'A recipient passcode does not work with fake QR codes, whose data can only be found with the main passphrase. Clear the passcode or choose another style.', true);
  }

  if (recips.length) {
    const opts = (id: string) => ($<HTMLDetailsElement>(id).open = true);
    if (passcode) {
      opts('more-opts');
      return setStatus(status, 'A recipient passcode does not combine with public keys. Clear the passcode, or remove the public keys.', true);
    }
    if (currentMode() === 'fakeqr') return setStatus(status, 'Fake QR codes cannot be sent to public keys (their data can only be found with a passphrase). Pick another style.', true);
    if (currentMode() === 'photo' && readExtras().length) {
      opts('multi');
      return setStatus(status, 'Extra messages in one photo are not combined with public keys. Remove them, or send the photo without public keys.', true);
    }
  }

  // Extra messages in the same photo, each with its own passphrase and optional passcode.
  const extraRows = !simple && currentMode() === 'photo' ? readExtras() : [];
  for (const [i, x] of extraRows.entries()) {
    const label = `Extra message ${i + 1}`;
    if (!x.text || !x.pass) {
      $<HTMLDetailsElement>('multi').open = true;
      return setStatus(status, `${label} needs both its text and its own passphrase (or remove it).`, true);
    }
    for (const [what, v] of [['passphrase', x.pass], ['passcode', x.passcode]] as const) {
      if (v && strength(v).level === 'weak' && !x.weakOk) {
        $<HTMLDetailsElement>('multi').open = true;
        return setStatus(status, `${label}: that ${what} is too easy to guess. Make it longer, press Generate, or tick "Use this weak passphrase or passcode anyway".`, true);
      }
    }
  }

  const btn = $<HTMLButtonElement>('btn-create');
  btn.disabled = true;
  $<HTMLButtonElement>('experience-toggle').disabled = true;
  setStatus(status, 'Encrypting… (deriving a memory-hard key takes about a second)');
  await sleep(30); // let the status paint before the heavy work
  $('out-wrap').hidden = true;
  openLink = null;
  const warn = $('warn');
  warn.hidden = true;
  try {
    const shrinkImage = async (target: number): Promise<Payload> => {
      setStatus(status, 'Image is too large. Trying local JPEG compression and resizing…');
      await sleep(0);
      const compressed = await compressSecretImage(imageSource!, Math.min(MAX_FILE_BYTES, target));
      if (!compressed) throw new Error('That image is still too large after compression. Choose a roomier style, enable splitting, or use a smaller image.');
      return { kind: 'file', name: imageName.replace(/\.[^.]+$/, '') + '.jpg', data: new Uint8Array(await compressed.arrayBuffer()) };
    };
    let payload = imageSource && imageSource.size > MAX_FILE_BYTES ? await shrinkImage(MAX_FILE_BYTES) : await loadPayload();
    const signer = await getSigner();
    const signatureVisibility = $<HTMLSelectElement>('sign-visibility').value === 'public' ? 'public' : 'private';
    const mode = currentMode();
    const kind = simple ? 'dct' : photoKind();
    const packetMode = { codeart: MODE_CODEART, qr: MODE_QR, fakeqr: MODE_FAKEQR, microdot: MODE_MICRODOT, photo: kind === 'dct' ? MODE_DCT : MODE_STEGO }[mode];
    const chosen = !simple && STYLES.find((s) => s === $<HTMLSelectElement>('anim-pick').value);
    const readTime = simple ? 60 : Number($<HTMLSelectElement>('read-time').value); // the 60 s default is not stored
    const readLocked = simple || $<HTMLInputElement>('chk-lock-read-time').checked;
    const readSecs = readTime === 60 && !readLocked ? 0 : readTime;
    const ttl = simple ? 0 : Number($<HTMLSelectElement>('expiry').value); // seconds, 0 = never
    const expiresAt = ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0;
    const anim = !simple && $<HTMLInputElement>('chk-nonsense').checked ? NO_ANIM : chosen ? styleToId(chosen) : 0;
    // A photo for public keys holds one message per way in (each recipient, and the passphrase if there is one), each placed
    // by a key the recipient can work out for themselves.
    let photoLead: PhotoMessage[] | undefined;
    pkPhotoCount = 0;
    const encryptPayload = async () => {
      if (recips.length && mode === 'photo') {
        photoLead = [];
        for (const r of recips) photoLead.push({ pass: photoPassFor(r), packet: await sealPayload(payload, '', packetMode, undefined, anim, expiresAt, '', readSecs, [r], readLocked, signer, signatureVisibility) });
        if (pass) photoLead.push({ pass, packet: await sealPayload(payload, pass, packetMode, undefined, anim, expiresAt, '', readSecs, [], readLocked, signer, signatureVisibility) });
        if (photoLead.length > MAX_MESSAGES) throw new Error(`A photo can hold ${MAX_MESSAGES} ways in. Choose fewer recipients, or leave out the passphrase.`);
        pkPhotoCount = photoLead.length;
      }
      // Photo images find a passcode through a locator record, so their packets carry no key slot.
      return photoLead
        ? photoLead[0].packet
        : sealPayload(payload, pass, packetMode, undefined, anim, expiresAt, mode === 'photo' ? '' : passcode, readSecs, recips, readLocked, signer, signatureVisibility);
    };
    let packet = await encryptPayload();
    const extras: PhotoMessage[] = [];
    for (const x of extraRows) {
      extras.push({ pass: x.pass, passcode: x.passcode, packet: await sealPayload({ kind: 'text', text: x.text }, x.pass, packetMode, undefined, anim, expiresAt, '', readSecs, [], readLocked, signer, signatureVisibility) });
    }

    let cover: Rgba | null = null;
    if (mode === 'photo') {
      const file = pastedCover ?? $<HTMLInputElement>('cover-file').files?.[0];
      if (file) {
        cover = await blobToRgba(file, kind === 'dct' ? MAX_COVER_SIDE : 2400);
        if (kind === 'dct') cover = cropTo8(cover);
      }
    }
    const maxFrame = frameCapacity(cover ?? undefined);
    const split = (simple || $<HTMLInputElement>('chk-split').checked) && extras.length === 0 && !photoLead;
    const maxPacket = split ? (maxFrame - PART_OVERHEAD) * MAX_PARTS : maxFrame;
    const largestPacket = () => Math.max(packet.length, ...(photoLead ?? []).map((p) => p.packet.length));
    let target = maxPacket;
    for (let attempt = 0; imageSource && payload.kind === 'file' && largestPacket() > maxPacket && attempt < 2; attempt++) {
      if (attempt === 0) target = Math.min(payload.data.length, maxPacket) - Math.max(0, largestPacket() - payload.data.length) - 128;
      else target -= largestPacket() - maxPacket + 128;
      payload = await shrinkImage(target);
      packet = await encryptPayload();
    }
    if (!split && [packet, ...extras.map((x) => x.packet), ...(photoLead ?? []).map((x) => x.packet)].some((p) => p.length > maxFrame)) {
      throw new Error(`Too much data for one image (about ${fmt(Math.max(0, maxFrame - FRAMING))} is the most for this style). Turn on splitting, pick a roomier style, or hide less.`);
    }
    const frames = split ? splitPacket(packet, maxFrame) : [packet];

    const imgs: Rgba[] = [];
    for (let i = 0; i < frames.length; i++) {
      setStatus(status, frames.length > 1 ? `Creating image ${i + 1} of ${frames.length}…` : 'Creating image…');
      await sleep(0); // let the status paint
      imgs.push(await renderFrame(frames[i], mode, kind, simple && mode === 'fakeqr' ? passcode : pass, cover, passcode, i === 0 ? extras : [], i === 0 ? photoLead : undefined));
    }

    const notes: string[] = [];
    if (imageSource && payload.kind === 'file' && payload.data.length < imageSource.size) {
      notes.push(`Image compressed locally from ${fmt(imageSource.size)} to ${fmt(payload.data.length)} as ${payload.name}. JPEG compression may reduce quality, flatten transparency or animation, and remove metadata. Your original image is unchanged. Choose File instead of Image to require exact original bytes.`);
    }
    notes.push(signer ? 'Signed with your Ed25519 key. Recipients must check your signing fingerprint through a trusted channel to identify you.' : 'Unsigned: encryption does not prove who sent this message. Choose a signing key under "Sign as a sender" to authenticate it.');
    if (signer) notes.push(signatureVisibility === 'private'
      ? 'Encrypted signature: only someone who can decrypt sees your signing key and signature. They could disclose them to others.'
      : 'Public signature: anyone who extracts the packet can see your signing key. Choose an encrypted signature to hide it.');
    if (recips.length) notes.push(`Locked to ${recips.length} public key${recips.length > 1 ? 's' : ''}: there is no passphrase to send${pass ? ' (the passphrase you entered also opens it)' : ''}. Only the owner of a matching private key can open it.`);
    if (frames.length > 1) notes.push(`This secret is split across ${frames.length} images. Send all of them (the recipient adds them all on the Reveal tab, in any order).`);
    if (mode === 'codeart') {
      if (packet.length > 8000 && frames.length === 1) notes.push('This is a large image. Some apps shrink big images, which can make it unreadable.');
    } else if (mode === 'qr') notes.push('Anyone can scan these QR codes, but they will only see encrypted gibberish without the passphrase.');
    else if (mode === 'fakeqr') notes.push('A phone scanner will show your decoy. Keep the images at their original size: cropping or heavy shrinking breaks the hidden data.');
    else if (mode === 'microdot') notes.push('Microdot: tiny full-colour pixels with no error correction. Send the exact original PNG as a file or attachment. Do not resize, crop, add a border, change colours or convert to JPEG. Reveal by uploading or pasting the image, not with a QR scanner. Existing greyscale microdots can still be opened.');
    else if (kind === 'dct') notes.push('Survives normal JPEG recompression, but not cropping, rotating or heavy resizing. Photos are limited to 1280 px so most apps leave them alone.' + (cover && frames.length > 1 ? ' All parts reuse your cover photo; without one, each part gets its own generated picture.' : ''));
    else notes.push('Send these as original PNG files or attachments. Pasting inline in Gmail, WhatsApp, iMessage and most social apps usually recompresses images and destroys the hidden data. If in doubt, use the JPEG-safe method.');
    warn.textContent = notes.join(' ');
    warn.hidden = notes.length === 0;

    // Photo and fake-QR images exist to hide that a secret is there, so they never get a link that gives it away.
    const direct = frames.length === 1 && (mode === 'codeart' || mode === 'qr') ? packetLink(frames[0], siteBase()) : '';
    openLink = direct && direct.length <= MAX_OPEN_LINK ? direct : null;
    if (openLink) notes.push('The copied message also has a link that opens the secret directly, for email programs that hide images. The encrypted data sits after the # in it (browsers never send that part to a server); the passphrase is not in it.');
    warn.textContent = notes.join(' ');
    warn.hidden = notes.length === 0;

    showOutputs(imgs, packet.length);
    outputCredential = simple ? 'passcode' : 'passphrase';
    $<HTMLAnchorElement>('out-reveal-link').href = siteBase() + '#reveal';
    $('out-reveal-link').textContent = siteBase() + '#reveal';
    $('out-wrap').hidden = false;
    if (simple) {
      try {
        await copyMessage(outs, siteBase() + '#reveal', outs.length === 1 ? openLink : null, outputCredential);
        setStatus(status, `Copied ${frames.length > 1 ? `all ${frames.length} images` : 'the image'} and reveal link. Paste into your message; share the passcode separately.`);
      } catch {
        setStatus(status, 'Image created, but automatic copying was blocked or is unavailable. Press Copy message below, or download the image and send the reveal link separately.', true);
      }
    } else {
      setStatus(status, frames.length > 1 ? `Done: ${frames.length} images. Copy the message or download them all.` : 'Done. Copy it into your message, or download it.');
    }
  } catch (e) {
    setStatus(status, (e as Error).message, true);
  } finally {
    pkPhotoCount = 0;
    btn.disabled = false;
    $<HTMLButtonElement>('experience-toggle').disabled = false;
  }
};

$('btn-copy').onclick = async () => {
  try {
    await copyImage(outs[0]);
    setStatus($('hide-status'), 'Image copied. Paste it into your message.');
  } catch (e) {
    setStatus($('hide-status'), (e as Error).message, true);
  }
};
$('btn-copy-msg').onclick = async () => {
  try {
    await copyMessage(outs, location.origin + location.pathname + '#reveal', outs.length === 1 ? openLink : null, outputCredential);
    setStatus(
      $('hide-status'),
      outs.length > 1
        ? `Message copied with all ${outs.length} images: paste it into an email. Chat apps may only take one image, so use each part's Copy button there.`
        : 'Message copied: paste it into an email or chat. If an app only takes the image, paste the link separately.',
    );
  } catch (e) {
    setStatus($('hide-status'), (e as Error).message, true);
  }
};
$('btn-download').onclick = async () => {
  for (let i = 0; i < outs.length; i++) {
    download(outs[i], partName(i, outs.length));
    if (outs.length > 1) await sleep(350); // browsers throttle rapid-fire downloads
  }
};
$('chk-split').addEventListener('change', syncKindUi);


// ---- reveal -----------------------------------------------------------------
interface Loaded {
  id: number;
  rgba: Rgba;
}
let images: Loaded[] = [];
let nextId = 1;
let handle: RevealHandle | null = null;
let replayReveal: (() => Promise<void>) | null = null;
let clearTimer: number | undefined;
// frames the camera has read so far (so it knows when a split set is complete)
let scannedFrames: Uint8Array[] = [];
const scannedKeys = new Set<string>();

function thumbOf(rgba: Rgba): HTMLCanvasElement {
  const full = rgbaToCanvas(rgba);
  const t = document.createElement('canvas');
  t.width = 168;
  t.height = 168;
  const ctx = t.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 168, 168);
  const s = Math.min(168 / full.width, 168 / full.height);
  ctx.drawImage(full, (168 - full.width * s) / 2, (168 - full.height * s) / 2, full.width * s, full.height * s);
  return t;
}

// When the loaded image is addressed to a public key, the passphrase box is for the key's passphrase: say so. Only
// images that can be read without a passphrase (microdot, code art, QR) can be recognised; a photo keeps the general wording.
const frameCache = new Map<number, Uint8Array | null>();
let labelToken = 0;
async function updateRevealLabel() {
  const mine = ++labelToken;
  const frames: Uint8Array[] = [];
  for (const im of images) {
    if (!frameCache.has(im.id)) {
      let frame: Uint8Array | null = null;
      for (const read of [() => decodeMicrodot(im.rgba), () => decodePlainQr(im.rgba), () => decodeCodeArt(im.rgba)]) {
        try {
          frame = read();
          parseFrame(frame);
          break;
        } catch {
          frame = null;
        }
      }
      frameCache.set(im.id, frame);
    }
    const f = frameCache.get(im.id);
    if (f) frames.push(f);
  }
  if (mine !== labelToken) return;
  let slots: ReturnType<typeof parsePacket>['slots'];
  try {
    const asm = assemble(frames);
    if (asm.state === 'single' || asm.state === 'complete') slots = parsePacket(asm.packet).slots;
  } catch {
    slots = undefined;
  }
  const hint = $('key-reveal-hint');
  if (slots) {
    $('pass2-label').textContent = "Your key's passphrase";
    const alsoPass = slots.some((s) => s.type === 1);
    hint.textContent = `This image was sent to a public key. Type the passphrase of your key, the one you chose when you made it (not a shared secret).${alsoPass ? " If the sender also gave you a passphrase, that works too." : ''}`;
    hint.hidden = false;
  } else {
    $('pass2-label').textContent = 'Passphrase or passcode';
    hint.textContent = "If the image was sent to your public key, type your key's passphrase here.";
    hint.hidden = !hasStoredKeys();
  }
}

function renderTray() {
  void updateRevealLabel();
  const tray = $('tray');
  tray.replaceChildren();
  for (const im of images) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Remove this image';
    x.onclick = () => {
      images = images.filter((i) => i.id !== im.id);
      resetScan();
      renderTray();
    };
    wrap.append(thumbOf(im.rgba), x);
    tray.append(wrap);
  }
  if (images.length > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'ghost small';
    all.textContent = 'Remove all';
    all.onclick = () => {
      images = [];
      resetScan();
      renderTray();
    };
    tray.append(all);
  }
  $('drop-text').innerHTML = images.length
    ? `<b>${images.length} image${images.length > 1 ? 's' : ''} loaded.</b> Enter the passphrase below, or add more (a split secret needs all its images).`
    : '<b>Paste an image here</b> (Ctrl/Cmd+V), drop files, or <label class="link" for="file-in">choose some</label>. A split secret needs all its images.';
}

function resetScan() {
  scannedFrames = [];
  scannedKeys.clear();
}

function addImage(rgba: Rgba) {
  images.push({ id: nextId++, rgba });
  renderTray();
  setStatus($('reveal-status'), '');
  showTab('reveal');
  $<HTMLInputElement>('pass2').focus();
}

async function loadBlobs(blobs: Blob[]) {
  let failed = 0;
  for (const b of blobs) {
    try {
      addImage(await blobToRgba(b));
    } catch {
      failed++;
    }
  }
  if (failed) setStatus($('reveal-status'), failed === blobs.length ? 'Could not read that image.' : `${failed} file${failed > 1 ? 's' : ''} could not be read as images.`, true);
}

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
  if (files.length && !$('panel-keys').hidden) return; // no picture is wanted on the keys tab
  if (files.length) {
    e.preventDefault();
    if (!$('panel-hide').hidden) {
      // Hiding a file: the pasted picture is the secret itself.
      if (currentKind() !== 'text') {
        setSecretImage(files[0]);
        return;
      }
      // Otherwise, with the photo style chosen, it is the cover photo.
      if (currentMode() === 'photo') {
        setCover(files[0]);
        return;
      }
    }
    loadBlobs(files);
  }
});
// Outlook add-in: the task pane page (same origin, this app in a frame) hands over the open email's image attachments.
window.addEventListener('message', (e) => {
  if (window.parent === window || e.source !== window.parent || e.origin !== location.origin) return;
  const d = e.data as { type?: string; mime?: string; bytes?: unknown } | null;
  if (d?.type !== 'st-image' || !(d.bytes instanceof ArrayBuffer) || d.bytes.byteLength > 20 * 1024 * 1024) return;
  loadBlobs([new Blob([d.bytes], { type: typeof d.mime === 'string' ? d.mime : 'image/png' })]);
});
$<HTMLInputElement>('file-in').onchange = (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = ''; // allows choosing the same file again
  if (files.length) loadBlobs(files);
};
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) loadBlobs(files);
});

let pendingFile: { name: string; data: Uint8Array } | null = null;

// ---- reading the secret aloud (with a voice on this device only) -------------------------------------
let speaking = false;
function setSpeaking(v: boolean) {
  speaking = v;
  $('btn-speak').textContent = v ? '⏹ Stop reading' : '🔊 Read aloud';
}
function refreshVoices() {
  const sel = $<HTMLSelectElement>('speak-voice');
  const voices = localVoices();
  const keep = sel.value;
  sel.replaceChildren(...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.voiceURI)));
  const mine = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const pick = voices.find((v) => v.voiceURI === keep) ?? voices.find((v) => v.lang.toLowerCase().startsWith(mine)) ?? voices[0];
  if (pick) sel.value = pick.voiceURI;
  const ok = voices.length > 0;
  sel.hidden = !ok || voices.length < 2;
  $('auto-speak-row').hidden = !ok;
  $<HTMLButtonElement>('btn-speak').disabled = !ok;
}
function speakSecret() {
  const voice = localVoices().find((v) => v.voiceURI === $<HTMLSelectElement>('speak-voice').value);
  const text = $<HTMLTextAreaElement>('plain').value;
  if (!text || !voice) return;
  setSpeaking(true);
  speak(text, voice, () => setSpeaking(false));
}
if (speechAvailable()) {
  refreshVoices();
  speechSynthesis.addEventListener('voiceschanged', refreshVoices);
  $('btn-speak').onclick = () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
    } else speakSecret();
  };
}

function showResult(p: Payload) {
  const isFile = p.kind === 'file';
  $('text-result').hidden = isFile;
  $('file-result').hidden = !isFile;
  $('btn-copy-plain').hidden = isFile;
  $('btn-speak').hidden = isFile || !speechAvailable();
  $('speak-note').hidden = isFile || !speechAvailable() || localVoices().length > 0;
  $('btn-save-file').hidden = !isFile;
  clearPreview();
  if (p.kind === 'file') {
    pendingFile = { name: p.name, data: p.data };
    const mime = IMAGE_EXT[(p.name.split('.').pop() ?? '').toLowerCase()];
    if (mime) {
      // a decrypted picture: show it (only raster formats; the browser never runs anything from these)
      const img = $<HTMLImageElement>('file-preview');
      img.src = URL.createObjectURL(new Blob([p.data as unknown as BlobPart], { type: mime }));
      img.hidden = false;
      $('btn-copy-img').hidden = false;
    }
    $('file-meta').textContent = `${p.name}  (${fmt(p.data.length)})`;
    const w = $('file-warn2');
    w.hidden = false;
    w.textContent = RISKY_EXT.test(p.name)
      ? 'Careful: this is an executable-type file. Only open it if you fully trust the sender.'
      : 'Files are never opened automatically. Only open it if you trust the sender.';
  } else {
    pendingFile = null;
    $<HTMLTextAreaElement>('plain').value = p.text;
  }
}

$('btn-save-file').onclick = () => {
  if (!pendingFile) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([pendingFile.data as unknown as BlobPart], { type: 'application/octet-stream' }));
  a.download = pendingFile.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

function clearPreview() {
  const img = $<HTMLImageElement>('file-preview');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
  img.hidden = true;
  $('btn-copy-img').hidden = true;
}

$('btn-copy-img').onclick = async () => {
  const img = $<HTMLImageElement>('file-preview');
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  try {
    await copyImage(c);
    setStatus($('read-status'), 'Image copied.');
  } catch (e) {
    setStatus($('read-status'), (e as Error).message, true);
  }
};

// When the reading time runs out the revealed text on the stage goes up in a puff of smoke and a vortex sucks it in; the
// extracted text and any picture are swallowed by the vortex too, and then everything is cleared. "Clear now" (and a new reveal) still clears at once.
let vanishToken = 0;
function stopRevealReplay() {
  replayReveal = null;
  $('read-animation').hidden = true;
  handle?.skip();
  handle = null;
}

$('btn-read-reveal').onclick = async () => {
  if (!replayReveal) return;
  const btn = $<HTMLButtonElement>('btn-read-reveal');
  btn.disabled = true;
  try {
    await replayReveal();
  } finally {
    btn.disabled = false;
  }
};

async function vanishAndClear() {
  clearInterval(clearTimer);
  stopRevealReplay();
  if (reducedMotion()) return clearResult();
  const mine = ++vanishToken;
  stopSpeaking(); // the time is up: the voice stops too
  setSpeaking(false);
  $('timer').textContent = 'Time is up.';
  const vanishing = ['plain', 'file-meta', 'file-preview'].map((id) => $(id));
  for (const e of vanishing) e.classList.add('vanishing');
  await poofCanvas($<HTMLCanvasElement>('stage'), 2800, () => mine !== vanishToken);
  for (const e of vanishing) e.classList.remove('vanishing');
  if (mine === vanishToken) {
    clearResult();
    $('stage-wrap').hidden = false; // what is left behind: a doodle peeking over the wall
    $('btn-skip').hidden = true;
    wallyPeek($<HTMLCanvasElement>('stage'));
  }
}

function clearResult() {
  vanishToken++; // stops a vanish that is still running
  stopRevealReplay();
  stopSpeaking();
  setSpeaking(false);
  $<HTMLCanvasElement>('stage').dataset.wally = ''; // and the doodle left behind by the last one
  $('btn-skip').hidden = false;
  for (const id of ['plain', 'file-meta', 'file-preview']) $(id).classList.remove('vanishing');
  clearPreview();
  pendingFile = null;
  $('file-meta').textContent = '';
  clearTimeout(clearTimer);
  clearInterval(clearTimer);
  $<HTMLTextAreaElement>('plain').value = '';
  $('result').hidden = true;
  $('stage-wrap').hidden = true;
  $('timer').textContent = '';
  $<HTMLSelectElement>('read-clear').disabled = false;
  $('read-lock-note').hidden = true;
  $('sender-status').textContent = '';
  $('sender-status').hidden = true;
  $('read-empty').hidden = false;
  setStatus($('read-status'), '');
}
$('btn-clear').onclick = clearResult;
$('btn-skip').onclick = () => handle?.skip();
$('btn-copy-plain').onclick = async () => {
  await navigator.clipboard.writeText($<HTMLTextAreaElement>('plain').value);
  setStatus($('read-status'), 'Text copied.');
};

class NoSecretError extends Error {}
class NoKeyError extends Error {}
const attemptStore = defaultStore();
let lockTimer: number | undefined;

const waitText = (ms: number) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`);

/** Shows a live countdown; the note explains what this protection is and is not. */
function showLockout(ms: number) {
  clearInterval(lockTimer);
  const status = $('reveal-status');
  const until = Date.now() + ms;
  const tick = () => {
    const left = until - Date.now();
    if (left <= 0) {
      clearInterval(lockTimer);
      setStatus(status, 'You can try again now.');
      return;
    }
    setStatus(status, `Too many failed attempts on these images. Try again in ${waitText(left)}. (This slows guessing on this device; a strong passphrase is what stops offline guessing.)`, true);
  };
  tick();
  lockTimer = window.setInterval(tick, 1000);
}

/** `pass` in the result is the passphrase that opens the packet: a photo's passcode resolves to the passphrase behind it. */
async function decodeImage(img: Rgba, pass: string, pkPasses: string[] = []): Promise<{ frame: Uint8Array; mode: 'codeart' | 'stego'; pass: string } | null> {
  const attempts: [() => Promise<Uint8Array | { frame: Uint8Array; pass: string }> | Uint8Array, 'codeart' | 'stego'][] = [
    [() => decodeMicrodot(img), 'codeart'],
    [() => decodePlainQr(img), 'codeart'],
    [() => decodeCodeArt(img), 'codeart'],
    [() => decodeFakeQr(img, pass), 'codeart'],
    [() => findPhoto('dct', img, pass, (f) => void parseFrame(f)), 'stego'],
    [() => findPhoto('lsb', img, pass, (f) => void parseFrame(f)), 'stego'],
    // images made before the memory-hard layout key
    [() => decodeFakeQr(img, pass, undefined, true), 'codeart'],
    [() => extractDct(img, pass, true), 'stego'],
    [() => extract(img, pass, true), 'stego'],
    // photos sent to one of my public keys are placed by a key made from that public key
    ...pkPasses.flatMap((pp): typeof attempts => [
      [() => findPhoto('dct', img, pp, (f) => void parseFrame(f)), 'stego'],
      [() => findPhoto('lsb', img, pp, (f) => void parseFrame(f)), 'stego'],
    ]),
  ];
  for (const [fn, mode] of attempts) {
    try {
      const found = await fn();
      const frame = found instanceof Uint8Array ? found : found.frame;
      parseFrame(frame); // a whole packet or one part; checksum verified
      return { frame, mode, pass: found instanceof Uint8Array ? pass : found.pass };
    } catch {
      /* try the next method */
    }
  }
  return null;
}

let passkeyPass = ''; // the key passphrase a passkey just handed back, for the next Reveal only
$('btn-passkey').onclick = async () => {
  const status = $('reveal-status');
  try {
    setStatus(status, 'Follow the prompt on your device (fingerprint, face or PIN)…');
    passkeyPass = await passphraseViaPasskey();
    setStatus(status, '');
    $('btn-reveal').click();
  } catch (e) {
    setStatus(status, e instanceof PasskeyError ? e.message : 'The passkey could not be used.', true);
  }
};

$('btn-reveal').onclick = async () => {
  const status = $('reveal-status');
  const pass = $<HTMLInputElement>('pass2').value || passkeyPass; // the passkey's passphrase is used once
  passkeyPass = '';
  if (!images.length) return setStatus(status, 'Paste or choose the image first.', true);
  if (!pass) return setStatus(status, 'Enter the passphrase.', true);
  const fp = await fingerprint(images.map((i) => i.rgba));
  const lock = checkLock(attemptStore, fp);
  if (lock.locked) return showLockout(lock.waitMs);

  clearResult();
  const revealToken = vanishToken;
  const btn = $<HTMLButtonElement>('btn-reveal');
  btn.disabled = true;
  setStatus(status, images.length > 1 ? `Decoding ${images.length} images…` : 'Decoding…');
  try {
    const frames: Uint8Array[] = [];
    let mode: 'codeart' | 'stego' = 'codeart';
    let unreadable = 0;
    let openPass = pass;
    const pkPasses = storedPublicKeys().map(photoPassFor);
    for (const im of images) {
      const r = await decodeImage(im.rgba, pass, pkPasses);
      if (r) {
        frames.push(r.frame);
        mode = r.mode;
        if (r.pass !== pass) openPass = r.pass;
      } else unreadable++;
    }
    const asm = assemble(frames);
    const skipped = unreadable ? ` ${unreadable} image${unreadable > 1 ? 's' : ''} could not be read.` : '';
    if (asm.state === 'none') {
      throw new NoSecretError(
        images.length > 1
          ? 'No hidden secret found in these images. They may have been cropped, recompressed or resized by the app they travelled through, or the passphrase may be wrong.'
          : 'No hidden secret found in this image. It may have been cropped, recompressed or resized by the app it travelled through.',
      );
    }
    if (asm.state === 'incomplete') {
      const miss = asm.missing.map((i) => i + 1);
      setStatus(status, `Found ${asm.have} of ${asm.total} parts. Missing part${miss.length > 1 ? 's' : ''} ${miss.join(', ')}: add ${miss.length > 1 ? 'those images' : 'that image'} and press Reveal again.${skipped}`);
      return;
    }
    if (asm.state === 'corrupt') throw new Error('The parts do not fit together (damaged, or from different secrets). Remove all images and add them again.');

    // The animation code is loaded now, while the key is derived, so it is ready by the time the secret opens. If it
    // cannot be fetched (offline), the secret is simply shown without the animation.
    const animModule = import('./reveal-anim').catch(() => null);
    // An image addressed to public keys: my stored keys are unlocked with the typed passphrase (which may also be the
    // sender's passphrase, if they added one).
    const info = parsePacket(asm.packet);
    let identities: Awaited<ReturnType<typeof unlockAll>> = [];
    if (info.slots) {
      identities = await unlockAll(pass);
      if (!identities.length && !hasStoredKeys() && !info.slots.some((s) => s.type === 1)) {
        throw new NoKeyError('This image was sent to a public key, and there is no key saved on this device. Restore your key from its backup (in the "My keys" tab), or open this on the device that has it.');
      }
    }
    const expectedSender = await getExpectedSender();
    const payload = await openPayload(asm.packet, info.slots ? pass : openPass, Date.now(), identities, expectedSender);
    const sender = await senderStatus(payload.sender, await listContacts().catch(() => []));
    if (revealToken !== vanishToken) return;
    const senderNote = $('sender-status');
    senderNote.textContent = sender.message;
    senderNote.className = sender.trusted ? 'status' : 'warn';
    senderNote.hidden = false;
    recordSuccess(attemptStore, fp);
    const text = payload.kind === 'text' ? payload.text : `📄 ${payload.name}\n${fmt(payload.data.length)}`;

    setStatus(status, '');
    $('read-empty').hidden = true;
    showTab('read');
    $('tab-read').focus();
    $('stage-wrap').hidden = false;
    $<HTMLTextAreaElement>('plain').value = '';
    const source = rgbaToCanvas(images[images.length - 1].rgba);
    const anim = await animModule;
    if (revealToken !== vanishToken) return;
    if (payload.anim === NO_ANIM) {
      $('stage-wrap').hidden = true; // the sender asked for no animation: just the message
    } else if (anim) {
      const play = async () => {
        if (revealToken !== vanishToken) return;
        // A manual choice wins; Auto uses the sender's choice, or picks at random.
        const pick = $<HTMLSelectElement>('anim-style').value;
        const style = STYLES.find((s) => s === pick) ?? idToStyle(payload.anim);
        handle = anim.playReveal({ canvas: $<HTMLCanvasElement>('stage'), source, text, mode, reduceMotion: reducedMotion(), style });
        await handle.done;
      };
      await play();
      if (revealToken !== vanishToken) return;
      replayReveal = play;
      $<HTMLSelectElement>('read-anim-style').value = $<HTMLSelectElement>('anim-style').value;
      $<HTMLInputElement>('chk-read-motion').checked = $<HTMLInputElement>('chk-motion').checked;
      $('read-animation').hidden = false;
    }
    showResult(payload);
    $('result').hidden = false;
    if (payload.kind === 'text' && $<HTMLInputElement>('chk-autospeak').checked && localVoices().length) speakSecret();
    if (payload.expires) setStatus($('read-status'), `Note: the sender set this secret to expire on ${new Date(payload.expires * 1000).toLocaleString()}.`);

    // The sender's reading time is a ceiling: the recipient may shorten it but never stretch it.
    const senderLimit = payload.readSecs === undefined ? 60 : payload.readSecs === NEVER_CLEAR ? Infinity : payload.readSecs;
    $<HTMLSelectElement>('read-clear').disabled = !!payload.readLocked;
    $('read-lock-note').hidden = !payload.readLocked;
    const myLimit = payload.readLocked ? Infinity : Number($<HTMLSelectElement>('read-clear').value) || Infinity;
    const limit = Math.min(senderLimit, myLimit);
    if (limit === Infinity) {
      $('timer').textContent = 'Stays on screen until you press Clear now.';
    } else {
      let left = limit;
      const tick = () => {
        $('timer').textContent = `Message will self destruct in ${left}s`;
        if (left-- <= 0) void vanishAndClear();
      };
      tick();
      clearTimer = window.setInterval(tick, 1000);
    }
  } catch (e) {
    showTab('reveal');
    const countsAsGuess = e instanceof WrongPassphraseError || e instanceof NoSecretError;
    if (e instanceof ExpiredError) recordSuccess(attemptStore, fp); // the passphrase was right, so it is not a guess
    if (e instanceof WrongPassphraseError) {
      const card = $('panel-reveal');
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
    setStatus(status, (e as Error).message, true);
    if (countsAsGuess) {
      const after = recordFailure(attemptStore, fp);
      if (after.locked) showLockout(after.waitMs);
    }
  } finally {
    btn.disabled = false;
  }
};

// ---- read the secret from a picture of text (OCR) ------------------------------
let ocrPreview: Preview | null = null;

function stopOcrCamera() {
  ocrPreview?.stop();
  ocrPreview = null;
  $('ocr-cam').hidden = true;
  $<HTMLButtonElement>('btn-ocr-cam').disabled = false;
}

async function runOcr(img: Rgba) {
  const status = $('ocr-status');
  const bar = $('ocr-bar');
  $('ocr-progress').hidden = false;
  bar.style.width = '0%';
  setStatus(status, 'Loading the text reader (first use only)…');
  try {
    const r = await readText(img, (msg, f) => {
      setStatus(status, msg);
      bar.style.width = `${Math.round(f * 100)}%`;
    });
    if (!r.text) {
      setStatus(status, 'No text found in that picture. Try better light, hold the camera steady, and fill the frame with the text.', true);
      return;
    }
    const box = $<HTMLTextAreaElement>('secret');
    box.value = box.value.trim() ? box.value.replace(/\s+$/, '') + '\n' + r.text : r.text;
    box.focus();
    setStatus(
      status,
      `Read ${r.text.length} characters (confidence ${r.confidence}%). ${r.confidence < 75 ? 'Low confidence: ' : ''}Check the text for misread characters before hiding it.`,
      r.confidence < 60,
    );
  } catch (e) {
    setStatus(status, `Could not read the picture: ${(e as Error).message || 'the text reader failed to load.'}`, true);
  } finally {
    $('ocr-progress').hidden = true;
  }
}

$('ocr-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    await runOcr(await blobToRgba(f, 4000));
  } catch {
    setStatus($('ocr-status'), 'Could not read that image file.', true);
  }
});

$('btn-ocr-paste').onclick = async () => {
  const status = $('ocr-status');
  try {
    if (!navigator.clipboard?.read) throw new Error('unsupported');
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return void (await runOcr(await blobToRgba(await item.getType(type), 4000)));
    }
    setStatus(status, 'No image found on the clipboard. Copy a picture of the text first.', true);
  } catch (e) {
    const denied = (e as Error).name === 'NotAllowedError';
    setStatus(status, denied ? 'Clipboard access was blocked. Allow it in the browser, or use Choose image.' : 'This browser cannot read the clipboard here (needs https or localhost). Use Choose image.', true);
  }
};

$('btn-ocr-cam').onclick = async () => {
  const status = $('ocr-status');
  stopOcrCamera();
  try {
    $<HTMLButtonElement>('btn-ocr-cam').disabled = true;
    $('ocr-cam').hidden = false;
    setStatus(status, 'Starting camera…');
    ocrPreview = await startPreview($<HTMLVideoElement>('ocr-video'));
    setStatus(status, 'Fill the frame with the text, hold steady, then press the button.');
  } catch (e) {
    stopOcrCamera();
    const err = e as Error;
    setStatus(
      status,
      err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser and try again.' : err.name === 'NotFoundError' ? 'No camera was found on this device.' : err.message || 'Could not start the camera.',
      true,
    );
  }
};
$('btn-ocr-snap').onclick = async () => {
  const frame = ocrPreview?.grab();
  stopOcrCamera();
  if (!frame) return setStatus($('ocr-status'), 'The camera has not produced a picture yet. Try again.', true);
  await runOcr(frame);
};
$('btn-ocr-cancel').onclick = () => {
  stopOcrCamera();
  setStatus($('ocr-status'), '');
};
$('tab-reveal').addEventListener('click', stopOcrCamera);
$('tab-keys').addEventListener('click', stopOcrCamera);
document.addEventListener('visibilitychange', () => document.hidden && stopOcrCamera());

syncModeUi();

// The shared link ends in #reveal so recipients land on the Reveal tab. A plain QR scanned with a phone camera
// opens #q=<encrypted packet>: load it as the image to reveal, then tidy the address bar.
function loadFromLink(): boolean {
  const m = /^#q=[A-Za-z0-9_-]+$/.test(location.hash);
  if (!m) return false;
  try {
    const frame = packetFromQrText(location.hash);
    parseFrame(frame); // a whole packet or one part; checksum verified
    images = [];
    resetScan();
    addImage(encodePlainQr(frame, siteBase())); // show the same QR image the sender made
    setStatus($('reveal-status'), 'The secret from the QR code is loaded. Enter the passphrase to reveal it.');
  } catch {
    showTab('reveal');
    setStatus($('reveal-status'), 'The data in that link is damaged or incomplete.', true);
  }
  history.replaceState(null, '', siteBase() + '#reveal'); // keep the packet out of the address bar
  return true;
}
const openFromHash = () => {
  if (loadFromLink()) return;
  showTab(location.hash === '#reveal' ? 'reveal' : 'hide');
};
if (location.hash === '#reveal' || location.hash.startsWith('#q=')) openFromHash();
window.addEventListener('hashchange', openFromHash);

// Public keys: the keys section, the recipient picker, and links like #to=stpub1:… that fill in a recipient.
initKeysUi({ siteBase, showHideTab: () => { setExperience(false); showTab('hide'); }, showKeysTab: () => showTab('keys') });
void handleToHash(location.hash);
window.addEventListener('hashchange', () => void handleToHash(location.hash));

// The Help panel (how it works, how to use it) opens from the button at the top right of either tab.
const helpDialog = $<HTMLDialogElement>('about');
function openHelp() {
  if (!helpDialog.open) helpDialog.showModal();
}
$('help-open').onclick = openHelp;
$('help-close').onclick = () => helpDialog.close();
// The guided tour (a separate chunk, fetched only when asked for) drives the page itself, slowly, with a demo secret.
$('help-demo').onclick = async () => {
  helpDialog.close();
  const wasSimple = simpleSend();
  try {
    const m = await import('./demo');
    setExperience(false);
    await m.runDemo({
      showTab,
      outputToReveal: () => {
        const c = outs[0];
        if (!c) return false;
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
        addImage({ width: c.width, height: c.height, data: px.data });
        return true;
      },
      revealCount: () => images.length,
      trimReveal: (n) => {
        images = images.slice(0, n);
        resetScan();
        renderTray();
      },
      clearResult,
    });
  } catch {
    setStatus($('hide-status'), 'The demo could not be loaded (are you offline?).', true);
  } finally {
    setExperience(wasSimple);
  }
};
helpDialog.addEventListener('click', (e) => {
  if (e.target === helpDialog) helpDialog.close(); // a click on the dimmed backdrop
});

// The landing page's Outlook add-in note: open the install steps, and copy the manifest link.
$('outlook-how').onclick = () => {
  openHelp(); // the install steps are in the Help panel
  $('outlook').scrollIntoView({ block: 'start' });
};
$('manifest-url').addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
$('btn-copy-manifest').onclick = async () => {
  const input = $<HTMLInputElement>('manifest-url');
  const btn = $('btn-copy-manifest');
  try {
    await navigator.clipboard.writeText(input.value);
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  } catch {
    input.select(); // the clipboard is blocked: the link is selected so Ctrl+C works
  }
};

// Enter in the passphrase box does the same as pressing Reveal.
$('pass2').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    $<HTMLButtonElement>('btn-reveal').click();
  }
});

$('btn-paste').onclick = async () => {
  const status = $('reveal-status');
  try {
    if (!navigator.clipboard?.read) throw new Error('unsupported');
    const blobs: Blob[] = [];
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) blobs.push(await item.getType(type));
    }
    if (!blobs.length) return setStatus(status, 'No image found on the clipboard. Copy the image first, then try again.', true);
    await loadBlobs(blobs);
  } catch (e) {
    const denied = (e as Error).name === 'NotAllowedError';
    setStatus(status, denied ? 'Clipboard access was blocked. Allow it in the browser, or press Ctrl/Cmd+V instead.' : 'This browser cannot read the clipboard here (needs https or localhost). Press Ctrl/Cmd+V instead.', true);
  }
};

// ---- camera scanning --------------------------------------------------------
let scanner: Scanner | null = null;

function stopScan() {
  scanner?.stop();
  scanner = null;
  $('cam-wrap').hidden = true;
  $<HTMLButtonElement>('btn-scan').disabled = false;
}

$('btn-scan').onclick = async () => {
  const status = $('reveal-status');
  stopScan();
  try {
    $<HTMLButtonElement>('btn-scan').disabled = true;
    $('cam-wrap').hidden = false;
    setStatus(status, 'Starting camera…');
    scanner = await startScanner($<HTMLVideoElement>('cam'), () => $<HTMLInputElement>('pass2').value, {
      onStatus: (m) => setStatus(status, m),
      onFound: (frame, image) => {
        let info: ReturnType<typeof parseFrame>;
        try {
          info = parseFrame(frame);
        } catch {
          return true;
        }
        const key = info.kind === 'part' ? `${info.part.setId}:${info.part.index}` : 'single';
        if (!scannedKeys.has(key)) {
          scannedKeys.add(key);
          scannedFrames.push(frame);
          addImage(image);
        }
        const asm = assemble(scannedFrames);
        if (info.kind === 'part' && asm.state !== 'complete') {
          setStatus(status, `Scanned part ${info.part.index + 1} of ${info.part.total}: ${scannedKeys.size} of ${info.part.total} collected. Keep scanning the other codes.`);
          return true; // keep the camera running for the next part
        }
        stopScan();
        if ($<HTMLInputElement>('pass2').value) $<HTMLButtonElement>('btn-reveal').click();
        else {
          setStatus(status, 'Scanned. Enter the passphrase and press Reveal.');
          $<HTMLInputElement>('pass2').focus();
        }
        return false;
      },
    });
  } catch (e) {
    stopScan();
    const err = e as Error;
    const msg =
      err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser and try again.'
      : err.name === 'NotFoundError' ? 'No camera was found on this device.'
      : err.message || 'Could not start the camera.';
    setStatus(status, msg, true);
  }
};
$('btn-scan-stop').onclick = () => {
  stopScan();
  setStatus($('reveal-status'), '');
};
document.addEventListener('visibilitychange', () => document.hidden && stopScan());
$('tab-hide').addEventListener('click', stopScan);
$('tab-keys').addEventListener('click', stopScan);
