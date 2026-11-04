// Binary framing, version 2 (current):
// 'S' 'T' | 2 | mode(1) | kdf(1) | memLog2(1) | iterations(1) | salt(16) | iv(12) | ctLen(4, BE) | ciphertext+tag | crc32(4, BE)
// Version 3 (an image that a second "pass code" can also open): the version 2 header followed by one key slot,
//   slot = salt(16) | iv(12) | wrapped key(32 + 16 tag)   (76 bytes)
// The slot holds the image's encryption key, locked by a key derived from the pass code, so either the passphrase
// or the pass code opens it. The slot is part of the authenticated header.
// Version 4 (an image addressed to public keys, and/or a passphrase, through a table of slots):
//   'S' 'T' | 4 | mode flags(1) | slotCount(1) | iv(12) | ctLen(4, BE) | slot... | ciphertext+tag | crc32(4, BE)
//   slot = type(1) + body: 1 = passphrase: memLog2(1) iterations(1) salt(16) iv(12) wrapped key(48)        (78 bytes)
//                          2 = X25519 recipient: throwaway public key(32) iv(12) wrapped key(48)            (92 bytes)
//                          3 = P-256 recipient: throwaway public key(65) iv(12) wrapped key(48)            (125 bytes)
//   Every slot wraps the same random 32-byte content key; the ciphertext is encrypted with that key, and the whole
//   header including every slot is authenticated by AES-GCM. A recipient tries each slot with each key it holds, so
//   the packet does not say who it is for.
// Version 1 (older images, PBKDF2 with 600,000 rounds):
// 'S' 'T' | 1 | mode(1) | salt(16) | iv(12) | ctLen(4, BE) | ciphertext+tag | crc32(4, BE)
// mode: low nibble = image mode, 0x10 = payload was deflated before encryption, 0x20 = payload is a file,
// 0x40 = the first decrypted byte is the sender's chosen reveal animation (kept inside the encryption),
// 0x80 = a 4-byte big-endian expiry time (Unix seconds) follows it, also inside the encryption,
// 0x08 = a 2-byte big-endian reading time (seconds the revealed secret stays on screen; 0xFFFF = until cleared) follows that.
// (Image modes are 1..5, so the low three bits are enough for the mode.)
// The whole header is authenticated by AES-GCM, so the stored key-derivation settings cannot be altered.
import type { KdfSpec } from './kdf';

export const MODE_CODEART = 1;
export const MODE_STEGO = 2;
export const MODE_DCT = 3;
export const MODE_QR = 4;
export const MODE_FAKEQR = 5;
export const FLAG_READ = 0x08;
export const FLAG_COMPRESSED = 0x10;
export const FLAG_FILE = 0x20;
export const FLAG_ANIM = 0x40;
export const FLAG_EXPIRY = 0x80;
export const VERSION = 1; // also the version of the split-part frame
export const VERSION_ARGON = 2;
export const VERSION_SLOT = 3;
export const VERSION_PK = 4;
export const SLOT_PASS = 1;
export const SLOT_X25519 = 2;
export const SLOT_P256 = 3;
export const SLOT_BODY_LEN: Record<number, number> = { 1: 78, 2: 92, 3: 125 };
export const MAX_SLOTS = 16;
const HEADER_LEN_PK = 21; // before the slots
export const HEADER_LEN = 36; // version 1
export const HEADER_LEN_V2 = 39;
export const SLOT_LEN = 76; // salt 16 + iv 12 + wrapped key 48
export const TAG_LEN = 16;
const KDF_ARGON2ID = 1;

export class PacketError extends Error {}

export interface PkSlot {
  type: number;
  body: Uint8Array;
}

export interface Packet {
  version: number;
  slots?: PkSlot[]; // version 4: the table of ways in (salt, iv-for-slots and kdf below are then unused)
  mode: number;
  compressed: boolean;
  isFile: boolean;
  hasAnim: boolean;
  hasExpiry: boolean;
  hasRead: boolean;
  slot?: Uint8Array; // the pass-code key slot (version 3 only)
  kdf: KdfSpec;
  salt: Uint8Array;
  iv: Uint8Array;
  header: Uint8Array; // authenticated as AES-GCM additional data
  ciphertext: Uint8Array;
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildHeader(
  mode: number,
  compressed: boolean,
  salt: Uint8Array,
  iv: Uint8Array,
  ctLen: number,
  isFile = false,
  kdf: KdfSpec = { type: 'pbkdf2' },
  hasAnim = false,
  hasExpiry = false,
  slot?: Uint8Array,
  hasRead = false,
): Uint8Array {
  const flags =
    mode | (compressed ? FLAG_COMPRESSED : 0) | (isFile ? FLAG_FILE : 0) | (hasAnim ? FLAG_ANIM : 0) | (hasExpiry ? FLAG_EXPIRY : 0) | (hasRead ? FLAG_READ : 0);
  const argon = kdf.type === 'argon2id';
  if (slot && (!argon || slot.length !== SLOT_LEN)) throw new PacketError('a pass code needs Argon2id and a full key slot');
  const fixed = argon ? HEADER_LEN_V2 : HEADER_LEN;
  const h = new Uint8Array(fixed + (slot ? SLOT_LEN : 0));
  h[0] = 0x53;
  h[1] = 0x54;
  h[2] = slot ? VERSION_SLOT : argon ? VERSION_ARGON : VERSION;
  h[3] = flags;
  let o = 4;
  if (kdf.type === 'argon2id') {
    h[4] = KDF_ARGON2ID;
    h[5] = kdf.memLog2;
    h[6] = kdf.iterations;
    o = 7;
  }
  h.set(salt, o);
  h.set(iv, o + 16);
  new DataView(h.buffer).setUint32(o + 28, ctLen);
  if (slot) h.set(slot, fixed);
  return h;
}

/** The header of a version 4 packet: the fixed part followed by every slot. */
export function buildHeaderPk(
  mode: number,
  compressed: boolean,
  iv: Uint8Array,
  ctLen: number,
  slots: PkSlot[],
  isFile = false,
  hasAnim = false,
  hasExpiry = false,
  hasRead = false,
): Uint8Array {
  if (slots.length < 1 || slots.length > MAX_SLOTS) throw new PacketError('a packet needs 1 to ' + MAX_SLOTS + ' slots');
  for (const s of slots) if (SLOT_BODY_LEN[s.type] !== s.body.length) throw new PacketError('bad slot');
  const len = HEADER_LEN_PK + slots.reduce((n, s) => n + 1 + s.body.length, 0);
  const h = new Uint8Array(len);
  h[0] = 0x53;
  h[1] = 0x54;
  h[2] = VERSION_PK;
  h[3] = mode | (compressed ? FLAG_COMPRESSED : 0) | (isFile ? FLAG_FILE : 0) | (hasAnim ? FLAG_ANIM : 0) | (hasExpiry ? FLAG_EXPIRY : 0) | (hasRead ? FLAG_READ : 0);
  h[4] = slots.length;
  h.set(iv, 5);
  new DataView(h.buffer).setUint32(17, ctLen);
  let o = HEADER_LEN_PK;
  for (const s of slots) {
    h[o++] = s.type;
    h.set(s.body, o);
    o += s.body.length;
  }
  return h;
}

function parsePk(buf: Uint8Array): Packet {
  if (buf.length < HEADER_LEN_PK + TAG_LEN + 4) throw new PacketError('truncated packet');
  const n = buf[4];
  if (n < 1 || n > MAX_SLOTS) throw new PacketError('bad slot count');
  const slots: PkSlot[] = [];
  let o = HEADER_LEN_PK;
  for (let i = 0; i < n; i++) {
    const len = SLOT_BODY_LEN[buf[o]];
    if (!len || o + 1 + len > buf.length) throw new PacketError('bad slot');
    slots.push({ type: buf[o], body: buf.slice(o + 1, o + 1 + len) });
    o += 1 + len;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const ctLen = dv.getUint32(17);
  if (o + ctLen + 4 > buf.length || ctLen < TAG_LEN) throw new PacketError('truncated packet');
  const end = o + ctLen;
  if (crc32(buf.subarray(0, end)) !== dv.getUint32(end)) throw new PacketError('checksum mismatch');
  return {
    version: VERSION_PK,
    slots,
    mode: buf[3] & 0x07,
    compressed: (buf[3] & FLAG_COMPRESSED) !== 0,
    isFile: (buf[3] & FLAG_FILE) !== 0,
    hasAnim: (buf[3] & FLAG_ANIM) !== 0,
    hasExpiry: (buf[3] & FLAG_EXPIRY) !== 0,
    hasRead: (buf[3] & FLAG_READ) !== 0,
    kdf: { type: 'pbkdf2' },
    salt: new Uint8Array(16),
    iv: buf.slice(5, 17),
    header: buf.slice(0, o),
    ciphertext: buf.slice(o, end),
  };
}

export function finishPacket(header: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.length + ciphertext.length + 4);
  out.set(header);
  out.set(ciphertext, header.length);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)));
  return out;
}

export function parsePacket(buf: Uint8Array): Packet {
  if (buf.length > 3 && buf[0] === 0x53 && buf[1] === 0x54 && buf[2] === VERSION_PK) return parsePk(buf);
  if (buf.length < HEADER_LEN + TAG_LEN + 4 || buf[0] !== 0x53 || buf[1] !== 0x54) throw new PacketError('not a VeilVia messaging image');
  const v = buf[2];
  if (v !== VERSION && v !== VERSION_ARGON && v !== VERSION_SLOT) throw new PacketError('unsupported version');
  let kdf: KdfSpec = { type: 'pbkdf2' };
  let o = 4; // start of the salt
  const slotLen = v === VERSION_SLOT ? SLOT_LEN : 0;
  if (v === VERSION_ARGON || v === VERSION_SLOT) {
    if (buf.length < HEADER_LEN_V2 + slotLen + TAG_LEN + 4 || buf[4] !== KDF_ARGON2ID) throw new PacketError('unsupported key derivation');
    kdf = { type: 'argon2id', memLog2: buf[5], iterations: buf[6] };
    o = 7;
  }
  const fixedEnd = o + 32;
  const headerLen = fixedEnd + slotLen;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const ctLen = dv.getUint32(o + 28);
  if (headerLen + ctLen + 4 > buf.length || ctLen < TAG_LEN) throw new PacketError('truncated packet');
  const end = headerLen + ctLen;
  if (crc32(buf.subarray(0, end)) !== dv.getUint32(end)) throw new PacketError('checksum mismatch');
  return {
    version: v,
    mode: buf[3] & 0x07,
    compressed: (buf[3] & FLAG_COMPRESSED) !== 0,
    isFile: (buf[3] & FLAG_FILE) !== 0,
    hasAnim: (buf[3] & FLAG_ANIM) !== 0,
    hasExpiry: (buf[3] & FLAG_EXPIRY) !== 0,
    hasRead: (buf[3] & FLAG_READ) !== 0,
    ...(slotLen ? { slot: buf.slice(fixedEnd, headerLen) } : {}),
    kdf,
    salt: buf.slice(o, o + 16),
    iv: buf.slice(o + 16, o + 28),
    header: buf.slice(0, headerLen),
    ciphertext: buf.slice(headerLen, end),
  };
}

/** Total packet size for a given ciphertext length (used for capacity estimates). */
export const packetSize = (ctLen: number): number => HEADER_LEN + ctLen + 4;

// ---- split parts -------------------------------------------------------------
// 'S' 'P' | version(1) | setId(6) | index(1) | total(1) | chunk | crc32(4, BE)
// A large packet is cut into numbered chunks; each chunk travels in its own image.

export const PART_OVERHEAD = 15;
export const MAX_PARTS = 60;

export interface Part {
  setId: string; // hex
  index: number; // 0-based
  total: number;
  chunk: Uint8Array;
}

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export function buildPart(setId: Uint8Array, index: number, total: number, chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(PART_OVERHEAD + chunk.length);
  out[0] = 0x53;
  out[1] = 0x50;
  out[2] = VERSION;
  out.set(setId, 3);
  out[9] = index;
  out[10] = total;
  out.set(chunk, 11);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)));
  return out;
}

export function parsePart(buf: Uint8Array): Part {
  if (buf.length < PART_OVERHEAD + 1 || buf[0] !== 0x53 || buf[1] !== 0x50) throw new PacketError('not a split part');
  if (buf[2] !== VERSION) throw new PacketError('unsupported version');
  const crc = new DataView(buf.buffer, buf.byteOffset).getUint32(buf.length - 4);
  if (crc32(buf.subarray(0, buf.length - 4)) !== crc) throw new PacketError('checksum mismatch');
  const index = buf[9];
  const total = buf[10];
  if (total < 2 || total > MAX_PARTS || index >= total) throw new PacketError('bad part numbering');
  return { setId: hex(buf.subarray(3, 9)), index, total, chunk: buf.slice(11, buf.length - 4) };
}

/** Accepts either a whole packet or one part; throws if it is neither. */
export function parseFrame(buf: Uint8Array): { kind: 'packet' } | { kind: 'part'; part: Part } {
  if (buf.length > 1 && buf[1] === 0x50) return { kind: 'part', part: parsePart(buf) };
  parsePacket(buf);
  return { kind: 'packet' };
}
