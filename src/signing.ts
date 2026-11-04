import { crc32, parsePacket, SIGNATURE_LEN, SIGNED_HEADER_LEN, VERSION_SIGNED } from './packet';
import { fingerprintWords, type Identity, type PublicKey } from './pubkey';

const bs = (u: Uint8Array) => u as unknown as BufferSource;
const DOMAIN = new TextEncoder().encode('VeilVia sender signature v1\0');

export class SignatureError extends Error {}

function signingData(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(DOMAIN.length + data.length);
  out.set(DOMAIN);
  out.set(data, DOMAIN.length);
  return out;
}

export function samePublicKey(a: PublicKey, b: PublicKey): boolean {
  return a.type === b.type && a.raw.length === b.raw.length && a.raw.every((v, i) => v === b.raw[i]);
}

/** Signs the complete encrypted packet, including its recipients and all authenticated settings. */
export async function signPacket(packet: Uint8Array, signer: Identity): Promise<Uint8Array> {
  if (signer.type !== 'ed25519' || signer.raw.length !== 32) throw new SignatureError('Choose an Ed25519 signing key.');
  if (parsePacket(packet).signature) throw new SignatureError('This packet is already signed.');
  const end = SIGNED_HEADER_LEN + packet.length;
  const out = new Uint8Array(end + SIGNATURE_LEN + 4);
  out.set([0x53, 0x54, VERSION_SIGNED, packet[3]]);
  out.set(signer.raw, 4);
  new DataView(out.buffer).setUint32(36, packet.length);
  out.set(packet, SIGNED_HEADER_LEN);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', signer.priv, bs(signingData(out.subarray(0, end)))));
  out.set(signature, end);
  new DataView(out.buffer).setUint32(end + SIGNATURE_LEN, crc32(out.subarray(0, end + SIGNATURE_LEN)));
  await verifyPacketSignature(parsePacket(out).signature);
  return out;
}

/** A valid signature establishes control of a key, not the identity of the person who owns it. */
export async function verifyPacketSignature(signature: ReturnType<typeof parsePacket>['signature'], expected?: PublicKey): Promise<PublicKey | undefined> {
  if (!signature) {
    if (expected) throw new SignatureError('Unsigned message: the required sender signature is missing. Nothing was revealed.');
    return undefined;
  }
  const sender: PublicKey = { type: 'ed25519', raw: signature.publicKey };
  try {
    const key = await crypto.subtle.importKey('raw', bs(sender.raw), 'Ed25519', false, ['verify']);
    if (!(await crypto.subtle.verify('Ed25519', key, bs(signature.value), bs(signingData(signature.data))))) {
      throw new SignatureError('Invalid sender signature. The message may be forged or damaged. Nothing was revealed.');
    }
  } catch (e) {
    if (e instanceof SignatureError) throw e;
    throw new SignatureError('Cannot verify this Ed25519 signature in this browser. Nothing was revealed.');
  }
  if (expected && !samePublicKey(sender, expected)) throw new SignatureError('This message is not signed by the required sender. Nothing was revealed.');
  return sender;
}

export interface SigningContact {
  type: PublicKey['type'];
  pub: Uint8Array;
  label: string;
  verified?: boolean;
}

export async function senderStatus(sender: PublicKey | undefined, contacts: SigningContact[]): Promise<{ trusted: boolean; message: string }> {
  if (!sender) return { trusted: false, message: 'Unsigned message. Sender identity is not verified; anyone can encrypt to your public key.' };
  const words = await fingerprintWords(sender);
  const known = contacts.find((c) => c.verified && samePublicKey(sender, { type: c.type, raw: c.pub }));
  return known
    ? { trusted: true, message: `Verified sender: ${known.label}. Ed25519 signature matches the signing key you checked. Fingerprint: ${words}` }
    : { trusted: false, message: `Valid Ed25519 signature, but unknown sender. Check this signing fingerprint with the sender through a trusted channel before trusting the message: ${words}` };
}
