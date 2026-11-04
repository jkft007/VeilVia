import { argon2Bytes, defaultKdf, type KdfSpec } from './kdf';
import { SLOT_P256, SLOT_PASS, SLOT_X25519, TAG_LEN, buildHeader, buildHeaderPk, finishPacket, parsePacket, type Packet, type PkSlot } from './packet';
import { unwrapWith, wrapForRecipient, type Identity, type PublicKey } from './pubkey';
import { PRIVATE_SIGNATURE_LEN, signPacket, signPrivatePayload, verifyPacketSignature, verifyPrivatePayload, type SignatureVisibility } from './signing';

const PBKDF2_ITERATIONS = 600_000; // version 1 packets only
const subtle = globalThis.crypto.subtle;
const bs = (u: Uint8Array) => u as unknown as BufferSource;

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase, or the image is damaged');
  }
}

const aesKey = (raw: Uint8Array, usages: KeyUsage[]) => subtle.importKey('raw', bs(raw), { name: 'AES-GCM', length: 256 }, false, usages);

async function deriveKey(passphrase: string, salt: Uint8Array, kdf: KdfSpec): Promise<CryptoKey> {
  if (kdf.type === 'argon2id') {
    const raw = await argon2Bytes(passphrase, salt, kdf.memLog2, kdf.iterations);
    return aesKey(raw, ['encrypt', 'decrypt']);
  }
  const raw = await subtle.importKey('raw', bs(new TextEncoder().encode(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bs(data)]).stream().pipeThrough(stream as unknown as ReadableWritablePair));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = (d: Uint8Array) => pipe(d, new CompressionStream('deflate-raw'));
const inflate = (d: Uint8Array) => pipe(d, new DecompressionStream('deflate-raw'));

export type Payload = { kind: 'text'; text: string } | { kind: 'file'; name: string; data: Uint8Array };

/** Strips paths and characters that are unsafe in file names; never returns an empty name. */
export function safeFileName(raw: string): string {
  let n = raw.split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || 'secret-file';
}

function encodePayload(p: Payload): Uint8Array {
  if (p.kind === 'text') return new TextEncoder().encode(p.text);
  const name = new TextEncoder().encode(safeFileName(p.name));
  const out = new Uint8Array(2 + name.length + p.data.length);
  new DataView(out.buffer).setUint16(0, name.length);
  out.set(name, 2);
  out.set(p.data, 2 + name.length);
  return out;
}

function decodeFile(plain: Uint8Array): Payload {
  if (plain.length < 2) throw new Error('Damaged file data');
  const n = new DataView(plain.buffer, plain.byteOffset).getUint16(0);
  if (2 + n > plain.length) throw new Error('Damaged file data');
  const name = safeFileName(new TextDecoder('utf-8').decode(plain.subarray(2, 2 + n)));
  return { kind: 'file', name, data: plain.slice(2 + n) };
}

/** A decrypted payload plus the optional settings the sender stored with it. */
export type Opened = Payload & {
  anim?: number; // reveal animation (1-based id)
  expires?: number; // Unix seconds after which the reveal step refuses to show it
  readSecs?: number; // how long the revealed secret stays on screen (NEVER_CLEAR = until cleared by hand)
  readLocked?: boolean; // whether the recipient may change the reading time
  sender?: PublicKey; // cryptographically verified signing key; identity still requires a trusted fingerprint
};

/** The stored reading time that means "do not clear automatically". */
export const NEVER_CLEAR = 0xffff;

/** Thrown after a correct passphrase when the sender's expiry time has passed. */
export class ExpiredError extends Error {
  constructor(public readonly expires: number) {
    super(`This secret expired on ${new Date(expires * 1000).toLocaleString()} and can no longer be revealed.`);
  }
}

/**
 * Encrypts a text or file payload with `passphrase` and returns a framed packet.
 * `anim` (1..255) is the sender's chosen reveal animation and `expiresAt` (Unix seconds, 0 = never) the time
 * after which the reveal step refuses to show it. Both are stored inside the encryption.
 * A non-empty `passcode` adds a second way in: the image key is stored in the image, locked by the passcode.
 */
export async function sealPayload(
  payload: Payload,
  passphrase: string,
  mode: number,
  kdf: KdfSpec = defaultKdf(),
  anim = 0,
  expiresAt = 0,
  passcode = '',
  readSecs = 0,
  recipients: PublicKey[] = [],
  readLocked = false,
  signer?: Identity,
  signatureVisibility: SignatureVisibility = 'public',
): Promise<Uint8Array> {
  if (signatureVisibility !== 'public' && signatureVisibility !== 'private') throw new Error('Choose public or private sender signing.');
  let data = encodePayload(payload);
  const hasAnim = anim > 0 && anim < 256;
  const hasExpiry = expiresAt > 0 && expiresAt < 2 ** 32;
  const hasRead = readSecs > 0 && readSecs <= NEVER_CLEAR;
  if (readLocked && !hasRead) throw new Error('A locked reading time must be set');
  const metaLen = (hasAnim ? 1 : 0) + (hasExpiry ? 4 : 0) + (hasRead ? (readLocked ? 4 : 2) : 0);
  if (metaLen) {
    const tagged = new Uint8Array(metaLen + data.length);
    let o = 0;
    if (hasAnim) tagged[o++] = anim;
    if (hasExpiry) {
      new DataView(tagged.buffer).setUint32(o, Math.floor(expiresAt));
      o += 4;
    }
    if (hasRead) {
      if (readLocked) {
        new DataView(tagged.buffer).setUint16(o, 0); // zero is reserved as the lock marker; valid reading times are nonzero
        o += 2;
      }
      new DataView(tagged.buffer).setUint16(o, Math.floor(readSecs));
      o += 2;
    }
    tagged.set(data, o);
    data = tagged;
  }
  let compressed = false;
  const z = await deflate(data);
  if (z.length < data.length) {
    data = z;
    compressed = true;
  }
  if (recipients.length) {
    if (passcode) throw new Error('A recipient passcode cannot be combined with public keys');
    const packet = await sealRecipients(data, compressed, payload.kind === 'file', hasAnim, hasExpiry, hasRead, mode, passphrase, kdf, recipients, signatureVisibility === 'private' ? signer : undefined);
    return signer && signatureVisibility === 'public' ? signPacket(packet, signer) : packet;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let slot: Uint8Array | undefined;
  let key: CryptoKey;
  if (passcode) {
    // The image key (made from the passphrase) is also stored in the image, locked by a key made from the passcode.
    if (kdf.type !== 'argon2id') throw new Error('A passcode needs the Argon2id key derivation');
    const raw = await argon2Bytes(passphrase, salt, kdf.memLog2, kdf.iterations);
    key = await aesKey(raw, ['encrypt', 'decrypt']);
    const saltB = crypto.getRandomValues(new Uint8Array(16));
    const ivB = crypto.getRandomValues(new Uint8Array(12));
    const keyB = await deriveKey(passcode, saltB, kdf);
    const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(ivB), additionalData: bs(salt) }, keyB, bs(raw)));
    slot = new Uint8Array(saltB.length + ivB.length + wrapped.length);
    slot.set(saltB, 0);
    slot.set(ivB, 16);
    slot.set(wrapped, 28);
  } else {
    key = await deriveKey(passphrase, salt, kdf);
  }
  const privateSignature = !!signer && signatureVisibility === 'private';
  const header = buildHeader(mode, compressed, salt, iv, data.length + TAG_LEN + (privateSignature ? PRIVATE_SIGNATURE_LEN : 0), payload.kind === 'file', kdf, hasAnim, hasExpiry, slot, hasRead, privateSignature);
  if (privateSignature) data = await signPrivatePayload(data, header, signer!);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(header) }, key, bs(data)));
  const packet = finishPacket(header, ct);
  return signer && !privateSignature ? signPacket(packet, signer) : packet;
}

export const sealText = (text: string, passphrase: string, mode: number, kdf?: KdfSpec) => sealPayload({ kind: 'text', text }, passphrase, mode, kdf);

/**
 * An image for public keys: every recipient (and the passphrase, if one is given) gets a slot that wraps the same random
 * content key, so any of them opens it. `recipients` are public keys, safe to hold and share.
 */
async function sealRecipients(
  data: Uint8Array,
  compressed: boolean,
  isFile: boolean,
  hasAnim: boolean,
  hasExpiry: boolean,
  hasRead: boolean,
  mode: number,
  passphrase: string,
  kdf: KdfSpec,
  recipients: PublicKey[],
  privateSigner?: Identity,
): Promise<Uint8Array> {
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const slots: PkSlot[] = [];
  for (const r of recipients) {
    const w = await wrapForRecipient(contentKey, r, iv);
    const body = new Uint8Array(w.eph.length + 12 + w.wrapped.length);
    body.set(w.eph, 0);
    body.set(w.iv, w.eph.length);
    body.set(w.wrapped, w.eph.length + 12);
    slots.push({ type: r.type === 'x25519' ? SLOT_X25519 : SLOT_P256, body });
  }
  if (passphrase) {
    if (kdf.type !== 'argon2id') throw new Error('A passphrase slot needs the Argon2id key derivation');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const ivW = crypto.getRandomValues(new Uint8Array(12));
    const k = await deriveKey(passphrase, salt, kdf);
    const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(ivW), additionalData: bs(iv) }, k, bs(contentKey)));
    const body = new Uint8Array(2 + 16 + 12 + wrapped.length);
    body[0] = kdf.memLog2;
    body[1] = kdf.iterations;
    body.set(salt, 2);
    body.set(ivW, 18);
    body.set(wrapped, 30);
    slots.push({ type: SLOT_PASS, body });
  }
  for (let i = slots.length - 1; i > 0; i--) { // a shuffled table, so a slot's position says nothing
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const header = buildHeaderPk(mode, compressed, iv, data.length + TAG_LEN + (privateSigner ? PRIVATE_SIGNATURE_LEN : 0), slots, isFile, hasAnim, hasExpiry, hasRead, !!privateSigner);
  if (privateSigner) data = await signPrivatePayload(data, header, privateSigner);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(header) }, await aesKey(contentKey, ['encrypt']), bs(data)));
  return finishPacket(header, ct);
}

/** Finds the content key in a version 4 packet's slots, using our private keys and/or a passphrase, and decrypts. */
async function openSlots(p: Packet, passphrase: string, identities: Identity[]): Promise<Uint8Array> {
  let contentKey: Uint8Array | null = null;
  for (const s of p.slots ?? []) {
    if (contentKey) break;
    if (s.type === SLOT_X25519 || s.type === SLOT_P256) {
      const want = s.type === SLOT_X25519 ? 'x25519' : 'p256';
      const ephLen = s.type === SLOT_X25519 ? 32 : 65;
      const slot = { eph: s.body.subarray(0, ephLen), iv: s.body.subarray(ephLen, ephLen + 12), wrapped: s.body.subarray(ephLen + 12) };
      for (const id of identities) {
        if (id.type !== want) continue;
        contentKey = await unwrapWith(id, slot, p.iv);
        if (contentKey) break;
      }
    }
  }
  if (!contentKey && passphrase) {
    for (const s of p.slots ?? []) {
      if (s.type !== SLOT_PASS) continue;
      try {
        const k = await deriveKey(passphrase, s.body.subarray(2, 18), { type: 'argon2id', memLog2: s.body[0], iterations: s.body[1] });
        contentKey = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(s.body.subarray(18, 30)), additionalData: bs(p.iv) }, k, bs(s.body.subarray(30))));
        break;
      } catch {
        /* not the passphrase for this slot */
      }
    }
  }
  if (!contentKey) throw new WrongPassphraseError();
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(p.iv), additionalData: bs(p.header) }, await aesKey(contentKey, ['decrypt']), bs(p.ciphertext)));
  } catch {
    throw new WrongPassphraseError();
  }
}

/** Verifies and decrypts a framed packet. Throws WrongPassphraseError on auth failure. */
export async function openPayload(buf: Uint8Array, passphrase: string, now = Date.now(), identities: Identity[] = [], expectedSender?: PublicKey): Promise<Opened> {
  const p = parsePacket(buf);
  await verifyPacketSignature(p.signature, p.privateSignature ? undefined : expectedSender);
  if (p.slots) return finishOpen(await openSlots(p, passphrase, identities), p, now, expectedSender);
  const decryptWith = async (k: CryptoKey) =>
    new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(p.iv), additionalData: bs(p.header) }, k, bs(p.ciphertext)));
  let plain: Uint8Array;
  const key = await deriveKey(passphrase, p.salt, p.kdf);
  try {
    plain = await decryptWith(key);
  } catch {
    if (!p.slot) throw new WrongPassphraseError();
    // Not the passphrase: perhaps it is the passcode, which unlocks the image key stored in the slot.
    const keyB = await deriveKey(passphrase, p.slot.subarray(0, 16), p.kdf);
    try {
      const raw = new Uint8Array(
        await subtle.decrypt({ name: 'AES-GCM', iv: bs(p.slot.subarray(16, 28)), additionalData: bs(p.salt) }, keyB, bs(p.slot.subarray(28))),
      );
      plain = await decryptWith(await aesKey(raw, ['decrypt']));
    } catch {
      throw new WrongPassphraseError();
    }
  }
  return finishOpen(plain, p, now, expectedSender);
}

/** Everything after the plaintext is known: inflate it and read the sender's stored settings. */
async function finishOpen(plain: Uint8Array, p: Packet, now: number, expectedSender?: PublicKey): Promise<Opened> {
  let sender: PublicKey | undefined = p.signature ? { type: 'ed25519', raw: p.signature.publicKey } : undefined;
  if (p.privateSignature) {
    const verified = await verifyPrivatePayload(plain, p.header, expectedSender);
    plain = verified.data;
    sender = verified.sender;
  }
  if (p.compressed) plain = await inflate(plain);
  let anim: number | undefined;
  let expires: number | undefined;
  let readSecs: number | undefined;
  let readLocked = false;
  if (p.hasAnim) {
    if (plain.length < 1) throw new Error('Damaged data');
    anim = plain[0];
    plain = plain.subarray(1);
  }
  if (p.hasExpiry) {
    if (plain.length < 4) throw new Error('Damaged data');
    expires = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
    plain = plain.subarray(4);
    // Only reached with the right passphrase, so a wrong guess never learns whether the secret has expired.
    if (now >= expires * 1000) throw new ExpiredError(expires);
  }
  if (p.hasRead) {
    if (plain.length < 2) throw new Error('Damaged data');
    const view = new DataView(plain.buffer, plain.byteOffset);
    readSecs = view.getUint16(0);
    plain = plain.subarray(2);
    if (readSecs === 0) {
      if (plain.length < 2) throw new Error('Damaged data');
      readLocked = true;
      readSecs = new DataView(plain.buffer, plain.byteOffset).getUint16(0);
      plain = plain.subarray(2);
    }
  }
  const tag = {
    ...(sender ? { sender } : {}),
    ...(anim === undefined ? {} : { anim }),
    ...(expires === undefined ? {} : { expires }),
    ...(readSecs === undefined ? {} : { readSecs }),
    ...(readLocked ? { readLocked: true } : {}),
  };
  if (p.isFile) return { ...decodeFile(plain), ...tag };
  return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(plain), ...tag };
}

/** Text-only convenience wrapper. */
export async function openPacket(buf: Uint8Array, passphrase: string): Promise<string> {
  const p = await openPayload(buf, passphrase);
  if (p.kind !== 'text') throw new Error('This packet holds a file, not text');
  return p.text;
}
