import { describe, expect, it } from 'vitest';
import { openPayload, sealPayload } from '../src/crypto';
import { KeyStoreError, addPasskeyLock, exportBackup, parseBackup, passphraseFromPasskey, protectKey, removePasskeyLock, unprotectKey } from '../src/keystore';
import { MODE_CODEART } from '../src/packet';
import { generateKeyPair, keyId, photoPassFor } from '../src/pubkey';
import { signPacket } from '../src/signing';

describe('protected private keys', () => {
  it('opens with the right passphrase and a message locked to the public key opens with it', async () => {
    const k = await generateKeyPair('x25519');
    const stored = await protectKey(k, '  Bob  ', 'correct horse battery staple 77');
    expect(stored.label).toBe('Bob');
    expect(stored.id).toBe(await keyId({ type: k.type, raw: k.raw }));
    const id = await unprotectKey(stored, 'correct horse battery staple 77');
    expect(id).not.toBeNull();
    const pkt = await sealPayload({ kind: 'text', text: 'for bob' }, '', MODE_CODEART, undefined, 0, 0, '', 0, [{ type: k.type, raw: k.raw }]);
    expect(await openPayload(pkt, '', Date.now(), [id!])).toMatchObject({ text: 'for bob' });
  });

  it('does not open with a wrong passphrase, and the private half is not in the stored record in the clear', async () => {
    const k = await generateKeyPair('p256');
    const stored = await protectKey(k, 'Eve', 'a long enough phrase 9911');
    expect(await unprotectKey(stored, 'something else entirely')).toBeNull();
    const hay = Array.from(stored.ct).join(',');
    expect(hay).not.toContain(Array.from(k.pkcs8.subarray(16, 40)).join(','));
  });

  it('is not extractable once opened', async () => {
    const k = await generateKeyPair('x25519');
    const id = await unprotectKey(await protectKey(k, 'x', 'long enough phrase 1234'), 'long enough phrase 1234');
    await expect(crypto.subtle.exportKey('pkcs8', id!.priv)).rejects.toThrow();
  });
});

describe('key backups', () => {
  it('restores a protected Ed25519 signing key without exposing its private half', async () => {
    const k = await generateKeyPair('ed25519');
    const stored = await protectKey(k, 'Alice signing', 'a signing key phrase 4471');
    const restored = await parseBackup(exportBackup(stored));
    expect(restored.type).toBe('ed25519');
    expect(await unprotectKey(restored, 'wrong passphrase')).toBeNull();
    const alice = await unprotectKey(restored, 'a signing key phrase 4471');
    expect(alice).not.toBeNull();
    await expect(crypto.subtle.exportKey('pkcs8', alice!.priv)).rejects.toThrow();
    const packet = await signPacket(await sealPayload({ kind: 'text', text: 'from Alice' }, 'message pass', MODE_CODEART), alice!);
    expect(await openPayload(packet, 'message pass', Date.now(), [], alice!)).toMatchObject({ text: 'from Alice', sender: { raw: k.raw } });
  });

  it('round-trips and still opens with the passphrase', async () => {
    const k = await generateKeyPair('x25519');
    const stored = await protectKey(k, 'Ann', 'backup phrase long enough 55');
    const back = await parseBackup(exportBackup(stored));
    expect(back.id).toBe(stored.id);
    expect(back.label).toBe('Ann');
    expect(await unprotectKey(back, 'backup phrase long enough 55')).not.toBeNull();
  });

  it('rejects things that are not backups, damaged ones and unreasonable settings', async () => {
    const k = await generateKeyPair('x25519');
    const text = exportBackup(await protectKey(k, 'Ann', 'backup phrase long enough 55'));
    await expect(parseBackup('hello')).rejects.toBeInstanceOf(KeyStoreError);
    await expect(parseBackup('{"format":"other"}')).rejects.toBeInstanceOf(KeyStoreError);
    await expect(parseBackup(text.replace(/"ct": "[^"]+"/, '"ct": "AAAA"'))).rejects.toBeInstanceOf(KeyStoreError);
    await expect(parseBackup(text.replace(/"memLog2": \d+/, '"memLog2": 30'))).rejects.toBeInstanceOf(KeyStoreError);
  });
});

describe('photo position for a public key', () => {
  it('is the same for the same key and differs between keys', async () => {
    const a = await generateKeyPair('x25519');
    const b = await generateKeyPair('x25519');
    expect(photoPassFor(a)).toBe(photoPassFor({ type: a.type, raw: a.raw }));
    expect(photoPassFor(a)).not.toBe(photoPassFor(b));
  });
});

describe('passkey as a second way to unlock a key', () => {
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(32));

  it('hands the passphrase back for the right passkey secret, and it opens the key', async () => {
    const k = await generateKeyPair('x25519');
    const stored = await protectKey(k, 'Me', 'a long phrase for the key 4417');
    const withPk = await addPasskeyLock(stored, 'a long phrase for the key 4417', credId, salt, prf);
    const pass = await passphraseFromPasskey(withPk, prf);
    expect(pass).toBe('a long phrase for the key 4417');
    expect(await unprotectKey(withPk, pass!)).not.toBeNull();
    expect(await unprotectKey(withPk, 'a long phrase for the key 4417')).not.toBeNull(); // the passphrase still works
  });

  it('gives nothing for another passkey, and refuses a wrong passphrase when adding', async () => {
    const k = await generateKeyPair('p256');
    const stored = await protectKey(k, 'Me', 'another long phrase 9021');
    await expect(addPasskeyLock(stored, 'not it', credId, salt, prf)).rejects.toBeInstanceOf(KeyStoreError);
    const withPk = await addPasskeyLock(stored, 'another long phrase 9021', credId, salt, prf);
    expect(await passphraseFromPasskey(withPk, crypto.getRandomValues(new Uint8Array(32)))).toBeNull();
    expect(await passphraseFromPasskey(stored, prf)).toBeNull();
  });

  it('is not written into the backup, and can be removed', async () => {
    const k = await generateKeyPair('x25519');
    const withPk = await addPasskeyLock(await protectKey(k, 'Me', 'yet another long phrase 33'), 'yet another long phrase 33', credId, salt, prf);
    expect(exportBackup(withPk)).not.toContain('wrapped');
    expect((await parseBackup(exportBackup(withPk))).pk).toBeUndefined();
    expect(removePasskeyLock(withPk).pk).toBeUndefined();
  });
});
