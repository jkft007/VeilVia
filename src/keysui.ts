// The public-key parts of the page: the "My keys" tab, and the recipient picker on the Hide tab.
import { rgbaToCanvas } from './imageio';
import {
  KeyStoreError,
  addPasskeyLock,
  deleteContact,
  deleteKey,
  exportBackup,
  listContacts,
  listKeys,
  parseBackup,
  passphraseFromPasskey,
  protectKey,
  removePasskeyLock,
  saveContact,
  saveKey,
  unprotectKey,
  type Contact,
  type StoredKey,
} from './keystore';
import { PasskeyError, createPasskey, passkeyPrf, passkeySupported } from './passkey';
import { PubKeyError, canUse, decodePublicKey, encodePublicKey, fingerprintWords, generateKeyPair, keyId, preferredKeyType, publicKeyLink, type Identity, type PublicKey } from './pubkey';
import { samePublicKey, SignatureError } from './signing';
import { encodeQr } from './qr';
import { qrToRgba } from './qrmodes';
import { strength } from './strength';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setStatus = (el: HTMLElement, msg: string, error = false) => {
  el.textContent = msg;
  el.classList.toggle('error', error);
};

interface Deps {
  siteBase: () => string;
  showHideTab: () => void;
  showKeysTab: () => void;
}
let deps: Deps;

interface Recipient {
  id: string;
  label: string;
  pub: PublicKey;
  words: string;
}
const recipients: Recipient[] = [];
let myKeys: StoredKey[] = [];
let contacts: Contact[] = [];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const button = (text: string, onClick: () => void, cls = 'ghost small') => {
  const b = el('button', text, cls);
  b.type = 'button';
  b.onclick = onClick;
  return b;
};

async function copyText(text: string, from?: HTMLInputElement | HTMLTextAreaElement) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    from?.select();
    return false;
  }
}

/** A delete button that asks twice, so one stray click cannot lose a key. */
function confirmButton(text: string, onConfirm: () => void) {
  const b = button(text, () => {
    if (b.dataset.armed) {
      onConfirm();
      return;
    }
    b.dataset.armed = '1';
    b.textContent = 'Really delete?';
    setTimeout(() => {
      delete b.dataset.armed;
      b.textContent = text;
    }, 4000);
  });
  return b;
}

// ---- recipients on the Hide tab ------------------------------------------------------
/** The public keys the secret should be locked to: the people added, plus my own key if "also to me" is ticked. */
export async function getRecipients(): Promise<PublicKey[]> {
  const out: PublicKey[] = recipients.map((r) => r.pub);
  const own = myKeys.find((k) => k.type !== 'ed25519');
  if (own && $<HTMLInputElement>('to-self').checked && out.length) {
    const mine = { type: own.type, raw: own.pub };
    if (!recipients.some((r) => r.id === own.id)) out.push(mine);
  }
  return out;
}
export const recipientCount = () => recipients.length;

function renderRecipients() {
  const list = $('to-list');
  list.replaceChildren();
  for (const r of recipients) {
    const row = el('div', '', 'recip');
    const who = el('div');
    who.append(el('b', r.label || 'Public key'), el('div', r.words, 'hint'));
    row.append(who, button('Remove', () => {
      recipients.splice(recipients.indexOf(r), 1);
      renderRecipients();
    }));
    list.append(row);
  }
  $('to-summary').textContent = recipients.length ? `(${recipients.length} recipient${recipients.length > 1 ? 's' : ''})` : '(none)';
  $('to-note').textContent = recipients.length
    ? 'Before you send: check these words with the key\'s owner by a channel you trust (a call, in person). If the words match, nobody swapped the key.'
    : '';
  $('pass-hint').textContent = recipients.length ? '(optional now: with a public key chosen, nobody needs it. Add one only as a second way in.)' : '(send it to your recipient a different way)';
  $('to-self-row').hidden = !(hasStoredKeys() && recipients.length);
}

async function addRecipient(pub: PublicKey, label: string) {
  if (pub.type === 'ed25519') throw new PubKeyError('That is a signing key, not an encryption key. Add it under "Add a sender\'s signing key" in My keys.');
  if (!(await canUse(pub.type))) throw new PubKeyError('This browser cannot encrypt to that kind of key.');
  const id = await keyId(pub);
  if (recipients.some((r) => r.id === id)) throw new PubKeyError('That key is already in the list.');
  if (recipients.length >= 8) throw new PubKeyError('That is the most recipients for one image (8).');
  recipients.push({ id, label: label.trim().slice(0, 60), pub, words: await fingerprintWords(pub) });
  renderRecipients();
}

async function onAddKey() {
  const status = $('to-status');
  const text = $<HTMLInputElement>('to-input').value;
  const label = $<HTMLInputElement>('to-label').value;
  try {
    const pub = await decodePublicKey(text);
    await addRecipient(pub, label);
    if (label.trim()) {
      await saveContact({ id: await keyId(pub), label: label.trim().slice(0, 60), type: pub.type, pub: pub.raw, added: Date.now() }).catch(() => undefined);
      await refresh();
    }
    $<HTMLInputElement>('to-input').value = '';
    $<HTMLInputElement>('to-label').value = '';
    setStatus(status, label.trim() ? 'Added, and saved to your contacts.' : 'Added.');
  } catch (e) {
    setStatus(status, (e as Error).message, true);
  }
}

async function onAddContact() {
  const id = $<HTMLSelectElement>('to-contact').value;
  const c = contacts.find((x) => x.id === id);
  if (!c) return;
  try {
    await addRecipient({ type: c.type, raw: c.pub }, c.label);
    setStatus($('to-status'), 'Added.');
  } catch (e) {
    setStatus($('to-status'), (e as Error).message, true);
  }
}

/** A link like https://…/#to=stpub1:… opens the Hide tab with that person's key already added. */
export async function handleToHash(hash: string): Promise<boolean> {
  const m = /^#to=(stpub1:[A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return false;
  deps.showHideTab();
  $<HTMLDetailsElement>('to-keys').open = true;
  try {
    const pub = await decodePublicKey(m[1]);
    await addRecipient(pub, '');
    setStatus($('to-status'), 'This link had a public key in it. Check its words with the person who sent the link before you rely on it.');
  } catch (e) {
    setStatus($('to-status'), (e as Error).message, true);
  }
  history.replaceState(null, '', deps.siteBase());
  return true;
}

// ---- my keys ---------------------------------------------------------------------------
function download(name: string, text: string) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// A passkey as a second way to unlock the key: it keeps the passphrase safe, so a fingerprint, face or PIN can bring it back.
function passkeyRow(k: StoredKey): HTMLElement {
  const box = el('div', '', 'passkeybox');
  box.append(el('b', 'Passkey for this key'));
  const wrap = el('div', '', 'row');
  box.append(wrap);
  if (k.pk) {
    wrap.append(
      el('span', 'On. Press "Reveal with passkey" on the Reveal tab to unlock this key with your fingerprint, face or PIN.', 'hint'),
      confirmButton('Remove passkey', async () => {
        await saveKey(removePasskeyLock(k)).catch(() => undefined);
        await refresh();
        setStatus($('key-status'), 'Passkey removed from this key. The passphrase still opens it.');
      }),
    );
  } else if (!passkeySupported()) {
    wrap.append(el('span', 'This browser cannot make passkeys here (it needs a secure https page and a recent Chrome, Edge or Safari).', 'hint'));
  } else {
    box.append(el('div', 'Keep the passphrase of this key safe with a passkey, so a fingerprint, face or PIN can bring it back instead of typing it. The passphrase still works.', 'hint'));
    const pass = el('input');
    pass.type = 'password';
    pass.autocomplete = 'off';
    pass.placeholder = "This key's passphrase";
    wrap.append(
      pass,
      button('Add passkey', async () => {
        const status = $('key-status');
        try {
          if (!pass.value) return setStatus(status, "Type this key's passphrase first: the passkey will keep it safe.", true);
          setStatus(status, 'Follow the prompt on your device to make the passkey…');
          const made = await createPasskey(k.label);
          await saveKey(await addPasskeyLock(k, pass.value, made.credId, made.prfSalt, made.prf));
          pass.value = '';
          await refresh();
          setStatus(status, 'Passkey added. Next time press "Reveal with passkey" instead of typing the passphrase. The passphrase still works, and keep the backup: a passkey stays on this device and is not part of it.');
        } catch (e) {
          setStatus(status, e instanceof KeyStoreError || e instanceof PasskeyError ? e.message : 'Could not add the passkey.', true);
        }
      }),
    );
    box.append(wrap);
  }
  return box;
}

async function renderMyKeys() {
  const box = $('my-keys');
  box.replaceChildren();
  if (!myKeys.length) {
    box.append(el('p', 'You have no key on this device yet. Make one below, then give people your public key (or the link) so they can send you secrets.', 'hint'));
    return;
  }
  for (const k of myKeys) {
    const pub = { type: k.type, raw: k.pub };
    const text = await encodePublicKey(pub);
    const signing = k.type === 'ed25519';
    const link = signing ? text : await publicKeyLink(pub, deps.siteBase());
    const card = el('div', '', 'keycard');
    card.append(el('b', k.label), el('span', ` · ${signing ? 'Ed25519 signing' : k.type === 'x25519' ? 'X25519' : 'P-256'}`, 'hint'), el('div', await fingerprintWords(pub), 'hint'));
    const field = el('input');
    field.type = 'text';
    field.readOnly = true;
    field.value = text;
    field.spellcheck = false;
    field.onfocus = () => field.select();
    const qrBox = el('div', '', 'qrbox');
    qrBox.hidden = true;
    const row = el('div', '', 'row');
    row.append(
      button('Copy public key', async () => setStatus($('key-status'), (await copyText(text, field)) ? 'Public key copied. Anyone may have it.' : 'Select the key and copy it.')),
      ...(signing ? [] : [button('Copy "send me a secret" link', async () => setStatus($('key-status'), (await copyText(link)) ? 'Link copied. It opens this site with your key ready to use.' : 'Could not copy the link here.', false))]),
      button('Show QR', () => {
        qrBox.hidden = !qrBox.hidden;
        if (!qrBox.hidden && !qrBox.firstChild) {
          const c = rgbaToCanvas(qrToRgba(encodeQr(new TextEncoder().encode(link), 'M')));
          c.style.cssText = 'width:180px;height:180px;image-rendering:pixelated;background:#fff';
          qrBox.append(c, el('div', signing ? 'Public signing key. Share it and compare its fingerprint through a trusted channel.' : 'Scan to open a "send me a secret" page for this key.', 'hint'));
        }
      }),
      button('Back up', () => {
        download(`veilvia-messaging-key-${k.label.replace(/[^\w-]+/g, '_') || 'key'}.json`, exportBackup(k));
        setStatus($('key-status'), 'Saved. The backup is still locked by the key\'s passphrase. Keep both somewhere safe: without them, you cannot use this key again.');
      }),
      confirmButton('Delete', async () => {
        await deleteKey(k.id).catch(() => undefined);
        await refresh();
        setStatus($('key-status'), signing ? 'Signing key deleted. Restore its backup to sign as this sender again.' : 'Key deleted from this device. Anything sent to it can no longer be opened here unless you restore a backup.');
      }),
    );
    card.append(field, row);
    if (!signing) card.append(passkeyRow(k));
    card.append(qrBox);
    box.append(card);
  }
}

async function renderContacts() {
  const box = $('contacts');
  box.replaceChildren();
  const sel = $<HTMLSelectElement>('to-contact');
  sel.replaceChildren();
  if (!contacts.length) box.append(el('p', 'No contacts yet. Add an encryption key on the Hide tab, or a signing key below.', 'hint'));
  for (const c of contacts) {
    const signing = c.type === 'ed25519';
    if (!signing) sel.append(new Option(c.label, c.id));
    const row = el('div', '', 'recip');
    const who = el('div');
    who.append(el('b', c.label), el('div', await fingerprintWords({ type: c.type, raw: c.pub }), 'hint'));
    if (signing) {
      who.append(el('div', c.verified ? 'Signing fingerprint checked' : 'Signing fingerprint NOT checked', 'hint'));
      who.append(button(c.verified ? 'Stop trusting this signing key' : 'I checked these words with the sender', async () => {
        try {
          await saveContact({ ...c, verified: !c.verified });
          await refresh();
          setStatus($('key-status'), c.verified ? 'Sender trust removed.' : `Signing fingerprint for "${c.label}" marked checked. You can now require this sender on the Reveal tab.`);
        } catch (e) {
          setStatus($('key-status'), (e as Error).message, true);
        }
      }));
    }
    row.append(who, confirmButton('Remove', async () => {
      await deleteContact(c.id).catch(() => undefined);
      await refresh();
    }));
    box.append(row);
  }
  $('to-contact-row').hidden = sel.options.length === 0;
  const expected = $<HTMLSelectElement>('sender-expected');
  const keep = expected.value;
  const label = expected.selectedOptions[0]?.textContent ?? 'Required sender';
  expected.replaceChildren(new Option('No required sender (show signature status)', ''));
  for (const c of contacts) if (c.type === 'ed25519' && c.verified) expected.append(new Option(c.label, c.id));
  if (keep && ![...expected.options].some((o) => o.value === keep)) expected.append(new Option(`${label} (no longer trusted)`, keep));
  expected.value = keep;
}

async function onAddSigningContact() {
  try {
    const pub = await decodePublicKey($<HTMLInputElement>('sign-contact-key').value);
    if (pub.type !== 'ed25519') throw new PubKeyError('Use the sender\'s Ed25519 signing key, not their encryption key.');
    const label = $<HTMLInputElement>('sign-contact-label').value.trim().slice(0, 60);
    if (!label) throw new PubKeyError('Give this signing contact a name.');
    const id = await keyId(pub);
    const old = contacts.find((c) => c.id === id && samePublicKey(pub, { type: c.type, raw: c.pub }));
    await saveContact({ id, label, type: pub.type, pub: pub.raw, added: old?.added ?? Date.now(), verified: old?.verified ?? false });
    $<HTMLInputElement>('sign-contact-key').value = '';
    $<HTMLInputElement>('sign-contact-label').value = '';
    await refresh();
    setStatus($('key-status'), 'Signing contact saved. Check its displayed words with the sender through a trusted channel before marking it checked.');
  } catch (e) {
    setStatus($('key-status'), (e as Error).message, true);
  }
}

export async function getSigner(): Promise<Identity | undefined> {
  const id = $<HTMLSelectElement>('sign-key').value;
  if (!id) return undefined;
  const input = $<HTMLInputElement>('sign-pass');
  try {
    const key = (await listKeys()).find((k) => k.id === id && k.type === 'ed25519');
    if (!key) throw new SignatureError('That signing key is no longer available. Choose a signing key again.');
    const signer = await unprotectKey(key, input.value);
    if (!signer) throw new SignatureError('The signing key could not be unlocked. Check its passphrase; no unsigned message was created.');
    return signer;
  } finally {
    input.value = '';
  }
}

export async function getExpectedSender(): Promise<PublicKey | undefined> {
  const id = $<HTMLSelectElement>('sender-expected').value;
  if (!id) return undefined;
  const c = (await listContacts()).find((c) => c.id === id && c.type === 'ed25519' && c.verified);
  if (!c) throw new SignatureError('The required sender is no longer trusted. Check their signing key again in My keys.');
  return { type: c.type, raw: c.pub };
}

/** Reloads the key and contact lists (the guided tour uses this after it removes its own key). */
export const refreshKeys = () => refresh();

/** Forgets the recipients picked on the Hide tab. */
export function clearRecipients() {
  recipients.length = 0;
  renderRecipients();
}

async function refresh() {
  try {
    [myKeys, contacts] = await Promise.all([listKeys(), listContacts()]);
  } catch (e) {
    myKeys = [];
    contacts = [];
    setStatus($('key-status'), (e as Error).message, true);
  }
  await renderMyKeys();
  await renderContacts();
  renderRecipients();
  const signing = $<HTMLSelectElement>('sign-key');
  const keep = signing.value;
  const label = signing.selectedOptions[0]?.textContent ?? 'Signing key';
  signing.replaceChildren(new Option('Do not sign', ''));
  for (const k of myKeys) if (k.type === 'ed25519') signing.append(new Option(k.label, k.id));
  if (keep && ![...signing.options].some((o) => o.value === keep)) signing.append(new Option(`${label} (unavailable)`, keep));
  signing.value = keep;
  $('key-reveal-hint').hidden = !hasStoredKeys();
  $('btn-passkey').hidden = !myKeys.some((k) => k.type !== 'ed25519' && k.pk);
  $<HTMLDetailsElement>('key-make').open = myKeys.length === 0; // with no key yet, the form is the first thing to see
}

async function onCreateKey() {
  const status = $('key-status');
  const label = $<HTMLInputElement>('key-label').value;
  const pass = $<HTMLInputElement>('key-pass').value;
  const again = $<HTMLInputElement>('key-pass2').value;
  if (!pass) return setStatus(status, 'Choose a passphrase to protect the key.', true);
  if (pass !== again) return setStatus(status, 'The two passphrases do not match.', true);
  if (strength(pass).level === 'weak' && !$<HTMLInputElement>('key-weak').checked) {
    return setStatus(status, 'That passphrase is too easy to guess. Make it longer, or tick "Use it anyway". Anyone who copies your browser data could try guesses on it.', true);
  }
  const btn = $<HTMLButtonElement>('key-create');
  btn.disabled = true;
  setStatus(status, 'Making the key… (protecting it takes about a second)');
  try {
    const signing = $<HTMLSelectElement>('key-purpose').value === 'signing';
    const pair = await generateKeyPair(signing ? 'ed25519' : await preferredKeyType()).catch((e) => {
      if (signing) throw new SignatureError('This browser cannot create Ed25519 signing keys. Use a current browser with Ed25519 support.');
      throw e;
    });
    let stored = await protectKey(pair, label, pass);
    const wantPasskey = !signing && $<HTMLInputElement>('key-passkey').checked;
    let passkeyNote = '';
    if (wantPasskey) {
      try {
        setStatus(status, 'Follow the prompt on your device to make the passkey…');
        const made = await createPasskey(label);
        stored = await addPasskeyLock(stored, pass, made.credId, made.prfSalt, made.prf);
      } catch (e) {
        passkeyNote = ` The passkey was not added (${e instanceof Error ? e.message : 'it failed'}); you can add it later from the key's card.`;
      }
    }
    await saveKey(stored);
    void navigator.storage?.persist?.(); // ask the browser not to clear it when space runs low
    $<HTMLInputElement>('key-label').value = '';
    $<HTMLInputElement>('key-pass').value = '';
    $<HTMLInputElement>('key-pass2').value = '';
    for (const id of ['key-pass', 'key-pass2']) $<HTMLInputElement>(id).type = 'password';
    $('key-show').textContent = 'Show';
    $('key-gen-note').hidden = true;
    await refresh();
    setStatus(status, signing
      ? 'Signing key made. Back it up, share its public half, and compare its fingerprint with your recipients through a trusted channel. Select it under "Sign as a sender" when creating a message.'
      : 'Key made. Now back it up: if this browser\'s data is cleared, anything sent to this key is lost for good. Then share your public key or link.' + passkeyNote);
  } catch (e) {
    setStatus(status, (e as Error).message, true);
  } finally {
    btn.disabled = false;
  }
}

async function onImport() {
  const status = $('key-status');
  try {
    let text = $<HTMLTextAreaElement>('key-import').value.trim();
    const file = $<HTMLInputElement>('key-import-file').files?.[0];
    if (!text && file) text = await file.text();
    if (!text) return setStatus(status, 'Choose the backup file, or paste its text.', true);
    const k = await parseBackup(text);
    await saveKey(k);
    $<HTMLTextAreaElement>('key-import').value = '';
    $<HTMLInputElement>('key-import-file').value = '';
    await refresh();
    setStatus(status, k.type === 'ed25519' ? `Restored signing key "${k.label}". Select it under "Sign as a sender" to sign messages.` : `Restored "${k.label}". Use the key's passphrase when you reveal a message sent to it.`);
  } catch (e) {
    setStatus(status, e instanceof KeyStoreError || e instanceof PubKeyError ? e.message : 'That backup could not be read.', true);
  }
}

/** The stored keys' public halves, for finding photos that were sent to them. */
export const storedPublicKeys = (): PublicKey[] => myKeys.filter((k) => k.type !== 'ed25519').map((k) => ({ type: k.type, raw: k.pub }));
export const hasStoredKeys = () => myKeys.some((k) => k.type !== 'ed25519');

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
/** Asks for a passkey (fingerprint, face or PIN) and gives back the key passphrase it was keeping safe. */
export async function passphraseViaPasskey(): Promise<string> {
  const locked = myKeys.filter((k) => k.type !== 'ed25519' && k.pk);
  if (!locked.length) throw new PasskeyError('No key on this device has a passkey yet. Add one in the "My keys" tab.');
  const { credId, prf } = await passkeyPrf(locked.map((k) => k.pk!));
  for (const k of locked) {
    if (!same(k.pk!.credId, credId)) continue;
    const p = await passphraseFromPasskey(k, prf);
    if (p) return p;
  }
  throw new PasskeyError('That passkey did not open a key here.');
}

export function initKeysUi(d: Deps) {
  deps = d;
  $('to-add').onclick = onAddKey;
  $('to-add-contact').onclick = onAddContact;
  $('key-create').onclick = onCreateKey;
  $('sign-contact-add').onclick = onAddSigningContact;
  $('sign-manage').onclick = () => {
    deps.showKeysTab();
    $<HTMLSelectElement>('key-purpose').value = 'signing';
    $<HTMLDetailsElement>('key-make').open = true;
    $('key-passkey-row').hidden = true;
  };
  $('key-purpose').onchange = () => {
    $('key-passkey-row').hidden = $<HTMLSelectElement>('key-purpose').value === 'signing' || !passkeySupported();
  };
  // A random passphrase for a new key: with a passkey keeping it safe, nobody has to remember or type it.
  $('key-gen').onclick = () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const pass = (Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('').match(/.{4}/g) ?? []).join('-');
    for (const id of ['key-pass', 'key-pass2']) {
      const i = $<HTMLInputElement>(id);
      i.value = pass;
      i.type = 'text';
    }
    $('key-show').textContent = 'Hide';
    $('key-pass').dispatchEvent(new Event('input', { bubbles: true }));
    const note = $('key-gen-note');
    if (passkeySupported() && $<HTMLSelectElement>('key-purpose').value !== 'signing') {
      $<HTMLInputElement>('key-passkey').checked = true;
      note.textContent = 'A random passphrase is filled in, and the passkey box is ticked: a fingerprint, face or PIN will bring it back, so you need not remember it. Also copy it somewhere safe (a password manager): if you lose this device and its passkey, it is the only way to open a restored backup.';
    } else {
      note.textContent = 'A random passphrase is filled in. Copy it somewhere safe (a password manager) now: it is needed to unlock this key and any restored backup.';
    }
    note.hidden = false;
  };
  $('key-show').onclick = () => {
    const hide = $<HTMLInputElement>('key-pass').type === 'password';
    for (const id of ['key-pass', 'key-pass2']) $<HTMLInputElement>(id).type = hide ? 'text' : 'password';
    $('key-show').textContent = hide ? 'Hide' : 'Show';
  };
  $('to-manage').onclick = () => deps.showKeysTab();
  $('key-passkey-row').hidden = !passkeySupported();
  $('key-import-btn').onclick = onImport;
  $('key-pass').addEventListener('input', () => {
    const { level } = strength($<HTMLInputElement>('key-pass').value);
    $('key-weak-row').hidden = level !== 'weak';
    if (level !== 'weak') $<HTMLInputElement>('key-weak').checked = false;
  });
  void refresh();
}
