// Keeping your own private keys and your contacts' public keys on this device.
// A private key is never stored as it is: it is encrypted with a passphrase through Argon2id and AES-GCM (the same memory-hard
// derivation the images use), so someone who copies the browser's storage still needs the passphrase. Keys and contacts live
// in IndexedDB; a backup is a small text file that holds the same encrypted form.
import { argon2Bytes, defaultKdf } from './kdf';
import { b64u, decodePublicKey, encodePublicKey, fromB64u, importIdentity, keyId, PUB_LEN, type Identity, type KeyType, type NewKey } from './pubkey';

const subtle = globalThis.crypto.subtle;
const bs = (u: Uint8Array) => u as unknown as BufferSource;
const utf8 = (s: string) => new TextEncoder().encode(s);

export class KeyStoreError extends Error {}

/** One of my own key pairs, with the private half locked by a passphrase. */
export interface StoredKey {
  id: string; // the key's id (from its fingerprint)
  label: string;
  type: KeyType;
  pub: Uint8Array;
  kdf: { memLog2: number; iterations: number };
  salt: Uint8Array;
  iv: Uint8Array;
  ct: Uint8Array; // the PKCS#8 private key, encrypted
  created: number;
  /** A passkey that keeps the passphrase safe as well (this device only; not part of the backup). */
  pk?: { credId: Uint8Array; prfSalt: Uint8Array; iv: Uint8Array; wrapped: Uint8Array };
}

/** Someone else's public key, saved with a name so it can be picked later. */
export interface Contact {
  id: string;
  label: string;
  type: KeyType;
  pub: Uint8Array;
  added: number;
  verified?: boolean; // signing fingerprint checked with its owner through a trusted channel
}

const aad = (type: KeyType, pub: Uint8Array) => {
  const t = utf8('SecretTransport-key-v1|' + type + '|');
  const out = new Uint8Array(t.length + pub.length);
  out.set(t);
  out.set(pub, t.length);
  return out;
};

async function lockKey(passphrase: string, salt: Uint8Array, kdf: { memLog2: number; iterations: number }): Promise<CryptoKey> {
  const raw = await argon2Bytes(passphrase, salt, kdf.memLog2, kdf.iterations);
  return subtle.importKey('raw', bs(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Locks a freshly made key pair with a passphrase, ready to be stored. */
export async function protectKey(k: NewKey, label: string, passphrase: string): Promise<StoredKey> {
  const spec = defaultKdf();
  if (spec.type !== 'argon2id') throw new KeyStoreError('Keys need the Argon2id key derivation');
  const kdf = { memLog2: spec.memLog2, iterations: spec.iterations };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await lockKey(passphrase, salt, kdf);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad(k.type, k.raw)) }, key, bs(k.pkcs8)));
  return { id: await keyId({ type: k.type, raw: k.raw }), label: label.trim().slice(0, 60) || 'My key', type: k.type, pub: k.raw, kdf, salt, iv, ct, created: Date.now() };
}

/** Opens a stored key with a passphrase: the usable private key, or null if the passphrase is wrong. */
export async function unprotectKey(s: StoredKey, passphrase: string): Promise<Identity | null> {
  try {
    const key = await lockKey(passphrase, s.salt, s.kdf);
    const pkcs8 = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(s.iv), additionalData: bs(aad(s.type, s.pub)) }, key, bs(s.ct)));
    return await importIdentity(s.type, s.pub, pkcs8);
  } catch {
    return null;
  }
}

// ---- passkey: the key's passphrase, kept safe by a passkey as well --------------------
// A passkey (WebAuthn with the PRF extension) gives a secret that only that passkey can produce, after a fingerprint, face or
// PIN check. That secret locks a copy of the key's passphrase, so the passkey can hand the passphrase back instead of it being
// typed. The passphrase still works, and the key's own encryption (and its backup) is unchanged.
const pkAad = (s: StoredKey) => {
  const a = aad(s.type, s.pub);
  const t = utf8('|passkey');
  const out = new Uint8Array(a.length + t.length);
  out.set(a);
  out.set(t, a.length);
  return out;
};

async function prfWrapKey(prf: Uint8Array): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', bs(prf), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8('SecretTransport passkey wrap v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Adds a passkey to a stored key. The passphrase has to be right: it is checked before it is locked away. */
export async function addPasskeyLock(s: StoredKey, passphrase: string, credId: Uint8Array, prfSalt: Uint8Array, prf: Uint8Array): Promise<StoredKey> {
  if (!(await unprotectKey(s, passphrase))) throw new KeyStoreError("That is not this key's passphrase.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(pkAad(s)) }, await prfWrapKey(prf), bs(utf8(passphrase))));
  return { ...s, pk: { credId, prfSalt, iv, wrapped } };
}

/** The passphrase a passkey was keeping safe, or null if this is not that passkey's secret. */
export async function passphraseFromPasskey(s: StoredKey, prf: Uint8Array): Promise<string | null> {
  if (!s.pk) return null;
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bs(s.pk.iv), additionalData: bs(pkAad(s)) }, await prfWrapKey(prf), bs(s.pk.wrapped));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function removePasskeyLock(s: StoredKey): StoredKey {
  const { pk: _pk, ...rest } = s;
  return rest;
}

// ---- the backup file ---------------------------------------------------------------
const FORMAT = 'secrettransport-key';

/** The key as text to save in a file or a password manager. Still locked by its passphrase. */
export function exportBackup(s: StoredKey): string {
  return JSON.stringify(
    { format: FORMAT, v: 1, label: s.label, type: s.type, pub: b64u(s.pub), kdf: s.kdf, salt: b64u(s.salt), iv: b64u(s.iv), ct: b64u(s.ct), created: s.created },
    null,
    2,
  );
}

export async function parseBackup(text: string): Promise<StoredKey> {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text);
  } catch {
    throw new KeyStoreError('That is not a VeilVia messaging key backup.');
  }
  const type = o.type;
  const kdf = o.kdf as { memLog2?: unknown; iterations?: unknown } | undefined;
  if (o.format !== FORMAT || o.v !== 1 || (type !== 'x25519' && type !== 'p256' && type !== 'ed25519') || !kdf || typeof kdf.memLog2 !== 'number' || typeof kdf.iterations !== 'number') {
    throw new KeyStoreError('That is not a VeilVia messaging key backup.');
  }
  const str = (v: unknown) => (typeof v === 'string' ? fromB64u(v) : new Uint8Array(0));
  const pub = str(o.pub);
  const salt = str(o.salt);
  const iv = str(o.iv);
  const ct = str(o.ct);
  if (pub.length !== PUB_LEN[type] || salt.length !== 16 || iv.length !== 12 || ct.length < 32) throw new KeyStoreError('That key backup is damaged or incomplete.');
  if (kdf.memLog2 < 3 || kdf.memLog2 > 18 || kdf.iterations < 1 || kdf.iterations > 10) throw new KeyStoreError('That key backup uses settings this app does not accept.');
  return {
    id: await keyId({ type, raw: pub }),
    label: typeof o.label === 'string' ? o.label.slice(0, 60) : 'Restored key',
    type,
    pub,
    kdf: { memLog2: kdf.memLog2, iterations: kdf.iterations },
    salt,
    iv,
    ct,
    created: typeof o.created === 'number' ? o.created : Date.now(),
  };
}

// ---- storage (IndexedDB) ---------------------------------------------------------------
const DB_NAME = 'secrettransport-keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new KeyStoreError('This browser cannot save keys here (private browsing can block it).'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys', { keyPath: 'id' });
      req.result.createObjectStore('contacts', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new KeyStoreError('This browser would not open its key storage (private browsing can block it).'));
  });
}

async function run<T>(store: 'keys' | 'contacts', mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = f(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(new KeyStoreError('Could not save that. The browser refused to store it.'));
      tx.onabort = () => reject(new KeyStoreError('Could not save that. The browser refused to store it.'));
    });
  } finally {
    db.close();
  }
}

export const listKeys = (): Promise<StoredKey[]> => run<StoredKey[]>('keys', 'readonly', (s) => s.getAll()).then((a) => a.sort((x, y) => x.created - y.created));
export const saveKey = (k: StoredKey): Promise<unknown> => run('keys', 'readwrite', (s) => s.put(k));
export const deleteKey = (id: string): Promise<unknown> => run('keys', 'readwrite', (s) => s.delete(id));
export const listContacts = (): Promise<Contact[]> => run<Contact[]>('contacts', 'readonly', (s) => s.getAll()).then((a) => a.sort((x, y) => x.label.localeCompare(y.label)));
export const saveContact = (c: Contact): Promise<unknown> => run('contacts', 'readwrite', (s) => s.put(c));
export const deleteContact = (id: string): Promise<unknown> => run('contacts', 'readwrite', (s) => s.delete(id));

/** Opens every stored key that this passphrase unlocks (a passphrase that opens none gives an empty list). */
export async function unlockAll(passphrase: string): Promise<Identity[]> {
  let keys: StoredKey[];
  try {
    keys = await listKeys();
  } catch {
    return [];
  }
  const out: Identity[] = [];
  for (const k of keys) {
    if (k.type === 'ed25519') continue;
    const id = await unprotectKey(k, passphrase);
    if (id) out.push(id);
  }
  return out;
}

export { decodePublicKey, encodePublicKey };
