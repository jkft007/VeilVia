// Public-key recipients: a person publishes a public key, anyone can lock a message to it, and only the matching
// private key (kept on that person's device, protected by a passphrase) opens it. Hybrid encryption: the image's
// content key is wrapped for each recipient with an ECDH exchange against a throwaway key (X25519, or P-256 where
// the browser has no X25519), so nothing secret has to be agreed beforehand.
import { FINGERPRINT_WORDS } from './words';

const subtle = globalThis.crypto.subtle;
const bs = (u: Uint8Array) => u as unknown as BufferSource;

export type KeyType = 'x25519' | 'p256';
export const KEY_TYPE_ID: Record<KeyType, number> = { x25519: 1, p256: 2 };
const TYPE_BY_ID: Record<number, KeyType> = { 1: 'x25519', 2: 'p256' };
export const PUB_LEN: Record<KeyType, number> = { x25519: 32, p256: 65 };

export class PubKeyError extends Error {}

/** A public key: safe to publish. */
export interface PublicKey {
  type: KeyType;
  raw: Uint8Array;
}

/** A private key made usable on this device. The CryptoKey cannot be exported again. */
export interface Identity extends PublicKey {
  priv: CryptoKey;
}

const algoOf = (t: KeyType) => (t === 'x25519' ? { name: 'X25519' } : { name: 'ECDH', namedCurve: 'P-256' });

// ---- small encoders -------------------------------------------------------------
export const b64u = (u: Uint8Array): string => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t.padEnd(Math.ceil(t.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (u: Uint8Array) => new Uint8Array(await subtle.digest('SHA-256', bs(u)));
const utf8 = (s: string) => new TextEncoder().encode(s);

// ---- supported algorithms ---------------------------------------------------------
let supported: Promise<KeyType> | undefined;
/** X25519 where the browser has it (short keys), otherwise P-256, which every current browser has. */
export function preferredKeyType(): Promise<KeyType> {
  supported ??= subtle
    .generateKey({ name: 'X25519' }, false, ['deriveBits'])
    .then(() => 'x25519' as const)
    .catch(() => 'p256' as const);
  return supported;
}

/** Whether this browser can use a key of this type at all (to refuse a recipient it cannot encrypt to). */
export async function canUse(type: KeyType): Promise<boolean> {
  try {
    await subtle.generateKey(algoOf(type) as EcKeyGenParams, false, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export interface NewKey {
  type: KeyType;
  raw: Uint8Array; // the public key
  pkcs8: Uint8Array; // the private key, to be protected with a passphrase before it is stored anywhere
}

export async function generateKeyPair(type?: KeyType): Promise<NewKey> {
  const t = type ?? (await preferredKeyType());
  const pair = (await subtle.generateKey(algoOf(t) as EcKeyGenParams, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    type: t,
    raw: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)),
    pkcs8: new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

/** Makes a stored private key usable for decrypting, without allowing it to be exported again. */
export async function importIdentity(type: KeyType, raw: Uint8Array, pkcs8: Uint8Array): Promise<Identity> {
  const priv = await subtle.importKey('pkcs8', bs(pkcs8), algoOf(type) as EcKeyImportParams, false, ['deriveBits']);
  return { type, raw, priv };
}

// ---- the text form of a public key ------------------------------------------------
const PREFIX = 'stpub1:';

/** `stpub1:` + base64url(type byte, key, 2-byte checksum): short enough to paste into a message or show as a QR. */
export async function encodePublicKey(k: PublicKey): Promise<string> {
  const body = concat(Uint8Array.of(KEY_TYPE_ID[k.type]), k.raw);
  const sum = (await sha256(body)).subarray(0, 2);
  return PREFIX + b64u(concat(body, sum));
}

/** Accepts the bare key text, or a link that has it after `#to=`. Throws PubKeyError if it is not a valid key. */
export async function decodePublicKey(text: string): Promise<PublicKey> {
  const m = /stpub1:([A-Za-z0-9_-]+)/.exec(text.trim());
  if (!m) throw new PubKeyError('That is not a VeilVia messaging public key (it should start with "stpub1:").');
  let bytes: Uint8Array;
  try {
    bytes = fromB64u(m[1]);
  } catch {
    throw new PubKeyError('That public key has damaged characters. Copy it again.');
  }
  const type = TYPE_BY_ID[bytes[0]];
  if (!type || bytes.length !== 1 + PUB_LEN[type] + 2) throw new PubKeyError('That public key is the wrong length. Copy all of it.');
  const body = bytes.subarray(0, bytes.length - 2);
  const sum = (await sha256(body)).subarray(0, 2);
  if (sum[0] !== bytes[bytes.length - 2] || sum[1] !== bytes[bytes.length - 1]) throw new PubKeyError('That public key has a typing mistake in it (its check failed). Copy it again.');
  const raw = bytes.slice(1, bytes.length - 2);
  // A key that is not on the curve would only fail later and confusingly: check it now.
  try {
    await subtle.importKey('raw', bs(raw), algoOf(type) as EcKeyImportParams, false, []);
  } catch {
    throw new PubKeyError('That is not a valid public key.');
  }
  return { type, raw };
}

/** The link someone can click to send this person a secret: the Hide tab opens with the key filled in. */
export async function publicKeyLink(k: PublicKey, base: string): Promise<string> {
  return `${base}#to=${await encodePublicKey(k)}`;
}

// ---- fingerprints -------------------------------------------------------------------
/** 9 bytes (72 bits) of SHA-256 over the key, long enough that nobody can make a look-alike key to match it. */
export async function fingerprintBytes(k: PublicKey): Promise<Uint8Array> {
  return (await sha256(concat(utf8('SecretTransport-fingerprint-v1'), Uint8Array.of(KEY_TYPE_ID[k.type]), k.raw))).subarray(0, 9);
}

/** Nine words in three groups of three, e.g. "tiger maple cloud · river stone lamp · ...". Read them aloud to compare. */
export async function fingerprintWords(k: PublicKey): Promise<string> {
  const b = await fingerprintBytes(k);
  const w = Array.from(b, (x) => FINGERPRINT_WORDS[x]);
  return [w.slice(0, 3), w.slice(3, 6), w.slice(6, 9)].map((g) => g.join(' ')).join(' · ');
}

/** A stable id for a key (used to store and look it up). */
export async function keyId(k: PublicKey): Promise<string> {
  return Array.from(await fingerprintBytes(k), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---- wrapping the content key for a recipient ----------------------------------------
const INFO = utf8('SecretTransport recipient slot v1');

async function wrapKeyFor(shared: ArrayBuffer, ephPub: Uint8Array, recipPub: Uint8Array): Promise<CryptoKey> {
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: bs(concat(INFO, ephPub, recipPub)) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const WRAPPED_LEN = 48; // a 32-byte content key + 16-byte tag

/**
 * Locks `contentKey` for one recipient: a fresh throwaway key pair, ECDH against the recipient's public key, HKDF to an AES
 * key, and AES-GCM over the content key. `bind` (the packet's own IV) ties the slot to this packet.
 * Returns the throwaway public key, the IV and the wrapped key: everything the recipient needs, and nothing secret.
 */
export async function wrapForRecipient(contentKey: Uint8Array, to: PublicKey, bind: Uint8Array): Promise<{ eph: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }> {
  const eph = (await subtle.generateKey(algoOf(to.type) as EcKeyGenParams, true, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const theirs = await subtle.importKey('raw', bs(to.raw), algoOf(to.type) as EcKeyImportParams, false, []);
  const shared = await subtle.deriveBits({ name: algoOf(to.type).name, public: theirs } as EcdhKeyDeriveParams, eph.privateKey, 256);
  const key = await wrapKeyFor(shared, ephPub, to.raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(bind) }, key, bs(contentKey)));
  return { eph: ephPub, iv, wrapped };
}

/** Tries to open one recipient slot with one of our private keys. Returns the content key, or null if it was not for this key. */
export async function unwrapWith(id: Identity, slot: { eph: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }, bind: Uint8Array): Promise<Uint8Array | null> {
  try {
    const theirs = await subtle.importKey('raw', bs(slot.eph), algoOf(id.type) as EcKeyImportParams, false, []);
    const shared = await subtle.deriveBits({ name: algoOf(id.type).name, public: theirs } as EcdhKeyDeriveParams, id.priv, 256);
    const key = await wrapKeyFor(shared, slot.eph, id.raw);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(slot.iv), additionalData: bs(bind) }, key, bs(slot.wrapped)));
  } catch {
    return null; // not addressed to this key (or damaged): the next one is tried
  }
}

/**
 * Photos hide their data at positions chosen by a key. For a photo sent to a public key that "passphrase" is made from the
 * recipient's public key: the recipient knows it without anything being shared, and it carries no secret (the encryption
 * is what protects the message; the position only makes the picture look ordinary).
 */
export const photoPassFor = (k: PublicKey): string => 'stpub-photo-v1:' + b64u(k.raw);
