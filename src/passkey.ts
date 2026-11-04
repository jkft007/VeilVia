// Passkeys (WebAuthn) as a second way to unlock a stored key. The "PRF" extension makes a passkey produce a secret of its own,
// only after the user passes the fingerprint, face or PIN check; that secret keeps the key's passphrase safe (see keystore.ts).
import { b64u } from './pubkey';

export class PasskeyError extends Error {}

const WEAK = 'This device or passkey cannot do this (it needs a passkey that supports the "PRF" extension, for example in current Chrome, Edge or Safari with a security key, Windows Hello, iCloud Keychain or Google Password Manager).';

export const passkeySupported = () => typeof PublicKeyCredential !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.credentials?.create;

interface PrfExt {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const bs = (u: Uint8Array) => u as unknown as BufferSource;

function explain(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError('The passkey check was cancelled or timed out.');
  if (name === 'SecurityError') return new PasskeyError('Passkeys need the secure site address (https), and this address cannot use them.');
  return new PasskeyError(WEAK);
}

/** The secret a passkey gives for a salt. `locks` are the passkeys that may answer; the one the user picks answers. */
export async function passkeyPrf(locks: { credId: Uint8Array; prfSalt: Uint8Array }[]): Promise<{ credId: Uint8Array; prf: Uint8Array }> {
  try {
    const evalByCredential: Record<string, { first: BufferSource }> = {};
    for (const l of locks) evalByCredential[b64u(l.credId)] = { first: bs(l.prfSalt) };
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: bs(rand(32)),
        rpId: location.hostname,
        allowCredentials: locks.map((l) => ({ type: 'public-key' as const, id: bs(l.credId) })),
        userVerification: 'required',
        extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const first = cred && (cred.getClientExtensionResults() as PrfExt).prf?.results?.first;
    if (!cred || !first) throw new PasskeyError(WEAK);
    return { credId: new Uint8Array(cred.rawId), prf: new Uint8Array(first) };
  } catch (e) {
    throw explain(e);
  }
}

/** Makes a new passkey for a key, and gets its first secret. */
export async function createPasskey(label: string): Promise<{ credId: Uint8Array; prfSalt: Uint8Array; prf: Uint8Array }> {
  try {
    const name = label.trim().slice(0, 60) || 'My key';
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'VeilVia messaging', id: location.hostname },
        user: { id: bs(rand(16)), name: `VeilVia messaging: ${name}`, displayName: name },
        challenge: bs(rand(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred || !(cred.getClientExtensionResults() as PrfExt).prf?.enabled) throw new PasskeyError(WEAK);
    const credId = new Uint8Array(cred.rawId);
    const prfSalt = rand(32);
    const got = await passkeyPrf([{ credId, prfSalt }]);
    return { credId, prfSalt, prf: got.prf };
  } catch (e) {
    throw explain(e);
  }
}
