// Several independent records can share one photo. The photo's slots (DCT coefficients or
// colour-channel LSBs) are divided into lanes that never overlap:
//   - message lanes: slot s belongs to message lane (s mod nMsg) of the head region, so each
//     message gets an equal share;
//   - locator lanes: small fixed-size blocks at the tail, each holding a tiny record that
//     leads from a passcode to a passphrase (see photo.ts).
// Inside a lane the slots are visited in an order scrambled by a key (an affine permutation),
// so a record can only be found by someone holding its key. A decoder does not know how many
// messages the image holds, so it tries every layout (at most 20) with the key it was given.
// The layout {nMsg: 1, nLoc: 0} is exactly the single-message layout of earlier versions.

export type Layout = { nMsg: number; nLoc: number };
export type Role = 'msg' | 'loc';

export const MAX_MESSAGES = 4;

/** Every layout a decoder tries, the single-message one first. */
export const LAYOUTS: Layout[] = [];
for (let nLoc = 0; nLoc <= MAX_MESSAGES; nLoc++) for (let nMsg = 1; nMsg <= MAX_MESSAGES; nMsg++) LAYOUTS.push({ nMsg, nLoc });

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export type Lane = { size: number; at: (k: number) => number };

/** Slots of the head region, which the message lanes divide between them. */
export const headSlots = (total: number, layout: Layout, locSize: number) => total - layout.nLoc * locSize;

/** Number of slots in each message lane (the smallest, when they differ by one). */
export const msgLaneSize = (total: number, layout: Layout, locSize: number) => Math.floor(headSlots(total, layout, locSize) / layout.nMsg);

/**
 * Maps position k inside a lane to a global slot index. `key` is the 32-byte layout key of the
 * record's owner; it fixes the scrambling. a * k stays below 2^53 for every size used here.
 */
export function laneOf(total: number, layout: Layout, locSize: number, role: Role, index: number, key: Uint8Array): Lane {
  const head = headSlots(total, layout, locSize);
  const size = role === 'msg' ? Math.floor((head - index + layout.nMsg - 1) / layout.nMsg) : locSize;
  if (size < 2) return { size: 0, at: () => 0 };
  const dv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  let a = (dv.getUint32(0) % size) | 1;
  while (gcd(a, size) !== 1) a = (a + 2) % size || 1;
  const b = dv.getUint32(4) % size;
  if (role === 'msg') {
    const n = layout.nMsg;
    return { size, at: (k) => index + n * ((a * k + b) % size) };
  }
  const base = head + index * locSize;
  return { size, at: (k) => base + ((a * k + b) % size) };
}
