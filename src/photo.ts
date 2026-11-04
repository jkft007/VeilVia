// Photo hiding with several messages and passcodes in one image.
//
// Each message is hidden in its own lane, scrambled by a key derived from ITS passphrase, so a
// passphrase finds only its own message. The finder cannot tell how many messages exist.
//
// A passcode cannot find a message directly (the message's position comes from its passphrase),
// so each passcode gets a tiny "locator" record in a small lane of its own, scrambled by a key
// derived from the passcode. The record holds the message's passphrase, encrypted under a
// second key from the passcode. Passcode -> locator -> passphrase -> message.
import type { Rgba } from './codeart';
import { cropTo8, dctCapacity, dctLocatorFits, embedDctEntries, extractDctLane, type DctEntry } from './dct';
import { layoutKey } from './kdf';
import { LAYOUTS, MAX_MESSAGES, type Layout, type Role } from './lanes';
import { embedEntries, extractLane, stegoCapacity, stegoLocatorFits, type StegoEntry } from './stego';

export type PhotoKind = 'dct' | 'lsb';
export type PhotoMessage = { pass: string; passcode?: string; packet: Uint8Array };

const PLAIN = 64; // locator plaintext: 1 length byte, up to 63 bytes of passphrase, random padding
const RECORD = 12 + PLAIN + 16; // IV + ciphertext + GCM tag
export const MAX_LOCATED_PASS_BYTES = PLAIN - 1;

export function photoLayout(messages: { passcode?: unknown }[]): Layout {
  return { nMsg: Math.max(1, messages.length), nLoc: messages.filter((m) => m.passcode).length };
}

/** Largest packet one message can carry in this cover with this many messages and passcodes. */
export function photoCapacity(kind: PhotoKind, cover: Rgba, layout: Layout): number {
  return kind === 'dct' ? dctCapacity(cover, layout) : stegoCapacity(cover, layout);
}

async function locatorKey(passcode: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', (await layoutKey(passcode, 'loc-key')) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function makeLocator(pass: string, passcode: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(pass);
  if (bytes.length > MAX_LOCATED_PASS_BYTES) throw new Error(`A passphrase paired with a passcode can be at most ${MAX_LOCATED_PASS_BYTES} bytes long.`);
  const plain = crypto.getRandomValues(new Uint8Array(PLAIN));
  plain[0] = bytes.length;
  plain.set(bytes, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await locatorKey(passcode), plain));
  const out = new Uint8Array(RECORD);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function openLocator(record: Uint8Array, passcode: string): Promise<string> {
  if (record.length !== RECORD) throw new Error('not a locator');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.subarray(0, 12) as BufferSource }, await locatorKey(passcode), record.subarray(12) as BufferSource));
  if (plain[0] > MAX_LOCATED_PASS_BYTES) throw new Error('not a locator');
  return new TextDecoder().decode(plain.subarray(1, 1 + plain[0]));
}

/** Hides every message (and a locator for each passcode) in one cover photo. */
export async function hidePhoto(kind: PhotoKind, cover: Rgba, messages: PhotoMessage[]): Promise<Rgba> {
  if (messages.length < 1 || messages.length > MAX_MESSAGES) throw new Error(`A photo can hold 1 to ${MAX_MESSAGES} messages.`);
  const keys = messages.flatMap((m) => (m.passcode ? [m.pass, m.passcode] : [m.pass]));
  if (new Set(keys.map((k) => k.normalize('NFKC'))).size !== keys.length) throw new Error('Every passphrase and passcode in one photo must be different.');

  const layout = photoLayout(messages);
  const img = kind === 'dct' ? cropTo8(cover) : cover;
  const cap = photoCapacity(kind, img, layout);
  const entries: (DctEntry & StegoEntry)[] = [];
  let loc = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.packet.length > cap) {
      throw new Error(`Too much data for this photo (about ${Math.max(0, cap - 70)} bytes per message with ${messages.length} message${messages.length > 1 ? 's' : ''}). Use a bigger cover photo, hide less, or use fewer messages.`);
    }
    entries.push({ role: 'msg', index: i, key: m.pass, data: m.packet });
    if (m.passcode) {
      const record = await makeLocator(m.pass, m.passcode);
      if (!(kind === 'dct' ? dctLocatorFits(record.length) : stegoLocatorFits(record.length))) throw new Error('Locator does not fit.');
      entries.push({ role: 'loc', index: loc++, key: m.passcode, data: record });
    }
  }
  return kind === 'dct' ? embedDctEntries(img, entries, layout) : embedEntries(img, entries, layout);
}

/**
 * Finds the message that `typed` opens: as a passphrase directly, or as a passcode through its
 * locator. `accept` throws for a record that is not a usable packet. Returns the passphrase that
 * actually opens the packet (the typed text, or the one the locator held).
 */
export async function findPhoto(kind: PhotoKind, img: Rgba, typed: string, accept: (frame: Uint8Array) => void): Promise<{ frame: Uint8Array; pass: string }> {
  const read = (key: string, layout: Layout, role: Role, index: number) => (kind === 'dct' ? extractDctLane(img, key, layout, role, index) : extractLane(img, key, layout, role, index));

  const tryMessages = async (key: string, layouts: Layout[]): Promise<Uint8Array | null> => {
    for (const layout of layouts)
      for (let i = 0; i < layout.nMsg; i++) {
        try {
          const frame = await read(key, layout, 'msg', i);
          accept(frame);
          return frame;
        } catch {
          /* not this lane */
        }
      }
    return null;
  };

  const direct = await tryMessages(typed, LAYOUTS);
  if (direct) return { frame: direct, pass: typed };

  for (let nLoc = 1; nLoc <= MAX_MESSAGES; nLoc++)
    for (let i = 0; i < nLoc; i++) {
      let pass: string;
      try {
        pass = await openLocator(await read(typed, { nMsg: 1, nLoc }, 'loc', i), typed);
      } catch {
        continue;
      }
      const frame = await tryMessages(pass, LAYOUTS.filter((l) => l.nLoc === nLoc));
      if (frame) return { frame, pass };
    }
  throw new Error('No hidden data found');
}
