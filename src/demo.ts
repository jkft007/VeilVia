// A guided tour: drives the real page, slowly, through hiding a demo secret in non-photo images, revealing it, and sending it to a
// public key. Nothing leaves the browser. The tour makes one temporary key and removes it again, and puts every field back as it was.
import { deleteKey, listKeys } from './keystore';
import { clearRecipients, refreshKeys } from './keysui';

export interface DemoDeps {
  showTab: (t: 'hide' | 'reveal' | 'keys') => void;
  /** Loads the image just made on the Hide tab into the Reveal tab, as if pasted. */
  outputToReveal: () => boolean;
  revealCount: () => number;
  trimReveal: (n: number) => void;
  clearResult: () => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
class Stopped extends Error {}

const SECRET = 'The vault code is 4-8-15-16-23-42. (This is only a demo secret.)';
const KEY_NAME = 'Demo tour key (temporary)';
const KEY_PASS = 'demo tour passphrase 2468 blue';
const TYPE_MS = 90; // time per typed letter: slow enough to read along
const FIELDS = ['secret', 'pass', 'mode', 'anim-pick', 'read-time', 'chk-lock-read-time', 'expiry', 'passcode', 'read-clear', 'anim-style', 'chk-motion', 'to-self', 'pass2', 'chk-split', 'chk-nonsense', 'chk-autospeak', 'sign-key', 'sign-pass', 'sign-visibility', 'sender-expected', 'key-purpose'];

let running = false;

export function demoRunning() {
  return running;
}

export async function runDemo(d: DemoDeps): Promise<void> {
  if (running) return;
  running = true;
  let stopped = false;
  let paused = false;

  // ---- the caption bar -------------------------------------------------------------
  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.setAttribute('role', 'status');
  const count = document.createElement('div');
  count.className = 'demo-count';
  const text = document.createElement('div');
  text.className = 'demo-text';
  const btns = document.createElement('div');
  btns.className = 'demo-btns';
  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'ghost small';
  pauseBtn.textContent = 'Pause';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'ghost small';
  stopBtn.textContent = 'Stop the tour';
  btns.append(pauseBtn, stopBtn);
  bar.append(count, text, btns);
  document.body.append(bar);
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  };
  stopBtn.onclick = () => {
    stopped = true;
  };

  let spot: HTMLElement | null = null;
  const highlight = (el: HTMLElement | null) => {
    spot?.classList.remove('demo-spot');
    spot = el;
    if (el) {
      el.classList.add('demo-spot');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const check = () => {
    if (stopped) throw new Stopped();
  };
  /** A wait that can be paused and stopped; time spent paused does not count. */
  const wait = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      check();
      await new Promise((r) => setTimeout(r, 100));
      if (!paused) left -= 100;
    }
    check();
  };
  const until = async (ok: () => boolean, maxMs: number, what: string) => {
    let t = 0;
    while (!ok()) {
      await wait(150);
      t += 150;
      if (t > maxMs) throw new Error(`The tour timed out waiting for ${what}.`);
    }
  };
  let n = 0;
  const TOTAL = 14;
  const say = (caption: string, target: HTMLElement | null = null) => {
    n++;
    count.textContent = `Step ${Math.min(n, TOTAL)} of ${TOTAL}`;
    text.textContent = caption;
    highlight(target);
  };
  const note = (caption: string) => {
    text.textContent = caption;
  };
  const fire = (el: HTMLElement, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, s: string) => {
    el.focus();
    el.value = '';
    fire(el, 'input');
    for (const ch of s) {
      check();
      el.value += ch;
      fire(el, 'input');
      await wait(TYPE_MS);
    }
  };
  const choose = (id: string, value: string) => {
    const el = $<HTMLSelectElement>(id);
    if ([...el.options].some((o) => o.value === value)) {
      el.value = value;
      fire(el, 'change');
    }
  };
  const press = (id: string) => $<HTMLButtonElement>(id).click();
  const done = async (id: string) => {
    await until(() => !$<HTMLButtonElement>(id).disabled, 60_000, 'the button to be ready again');
  };

  // ---- remember the page as it is, to put it back -----------------------------------------
  const saved = new Map<string, string | boolean>();
  for (const id of FIELDS) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) saved.set(id, el.type === 'checkbox' ? el.checked : el.value);
  }
  const passWasHidden = $<HTMLInputElement>('pass').type === 'password';
  const revealBefore = d.revealCount();
  for (const k of await listKeys().catch(() => [])) if (k.label === KEY_NAME) await deleteKey(k.id).catch(() => undefined); // left over from a tour that was cut short
  const keyIdsBefore = new Set((await listKeys().catch(() => [])).map((k) => k.id));
  const moreWasOpen = $<HTMLDetailsElement>('more-opts').open;
  const toKeysWasOpen = $<HTMLDetailsElement>('to-keys').open;
  d.clearResult();
  $<HTMLInputElement>('chk-motion').checked = false; // the tour is about the animations

  try {
    choose('sign-key', '');
    $<HTMLInputElement>('sign-pass').value = '';
    choose('sender-expected', '');
    choose('key-purpose', 'encryption');
    // 1 ------------------------------------------------------------------------------------------------
    d.showTab('hide');
    say('Welcome. This tour does everything for real, slowly: it hides a demo secret in an image, opens it again, then sends one to a public key. Use Pause to read at your own speed, or Stop to leave.');
    await wait(7000);

    // 2 ------------------------------------------------------------------------------------------------
    $<HTMLInputElement>('pass').value = '';
    fire($('pass'), 'input');
    choose('mode', 'codeart');
    say('Type or paste the secret on the Hide tab. It can also be a file, a picture, or text read from a photo.', $('secret'));
    await wait(2500);
    await typeInto($<HTMLTextAreaElement>('secret'), SECRET);
    await wait(2500);

    // 3 ------------------------------------------------------------------------------------------------
    say('A passphrase locks it. Generate makes a long random one, and the meter shows how hard it would be to guess.', $('pass'));
    await wait(3000);
    press('pass-gen');
    const pass = $<HTMLInputElement>('pass').value;
    await wait(7000);

    // 4 ------------------------------------------------------------------------------------------------
    say('Pick the image style. Code art is a colourful mosaic that survives JPEG compression, resizing and screenshots, so it works in almost any app. (Hidden-in-a-photo is not part of this tour.)', $('mode'));
    await wait(8000);

    // 5 ------------------------------------------------------------------------------------------------
    $<HTMLDetailsElement>('more-opts').open = true;
    say('More options travel inside the encrypted image: the reveal animation your recipient will see, how long they may read it, and when it expires. A recipient pass code is a second way in.', $('more-opts'));
    await wait(3000);
    choose('anim-pick', 'icemelt');
    choose('read-time', '10');
    $<HTMLInputElement>('chk-lock-read-time').checked = false;
    fire($('chk-lock-read-time'), 'change');
    choose('expiry', '3600');
    await wait(7000);

    // 6 ------------------------------------------------------------------------------------------------
    say('Create image. Your browser encrypts the secret (AES-256, with the key made slowly by Argon2id so guessing is expensive) and draws the image. Nothing is uploaded.', $('btn-create'));
    await wait(4000);
    press('btn-create');
    await until(() => !$('out-wrap').hidden && !$<HTMLButtonElement>('btn-create').disabled, 60_000, 'the image');
    highlight($('out-canvas'));
    note('This is the secret, hidden in plain sight. Paste it into an email or chat, or download it. The passphrase goes by another route.');
    await wait(8000);

    // 7 ------------------------------------------------------------------------------------------------
    say('The recipient adds the image on the Reveal tab: paste, drop, choose it, or scan it with the camera.');
    if (!d.outputToReveal()) throw new Error('There was no image to load.');
    highlight($('tray'));
    await wait(6000);
    highlight($('pass2'));
    note('First, a wrong passphrase. It is refused, and repeated wrong guesses on this device are slowed down.');
    await typeInto($<HTMLInputElement>('pass2'), 'a wrong guess');
    await wait(1500);
    press('btn-reveal');
    await done('btn-reveal');
    await wait(5000);

    // 8 ------------------------------------------------------------------------------------------------
    say('Now the right passphrase.', $('pass2'));
    await wait(1500);
    await typeInto($<HTMLInputElement>('pass2'), pass);
    await wait(2000);
    choose('read-clear', '15');
    note('The right passphrase opens it with an animation. There are 84: this one was chosen by the sender and stored inside the image. The recipient can pick another.');
    press('btn-reveal');
    await until(() => !$('stage-wrap').hidden, 30_000, 'the animation');
    highlight($('stage'));
    await until(() => !$('result').hidden, 90_000, 'the secret');
    await wait(1500);

    // 9 ------------------------------------------------------------------------------------------------
    say('The secret is back. Copy it, or save it if it was a file. It self-destructs after the reading time, and the recipient can shorten that time but never stretch it.', $('plain'));
    await wait(9000);
    note('Watch the timer: when the time is up the text goes up in a puff of smoke and a vortex sucks it away, and the extracted text disappears with it.');
    await until(() => $('result').hidden, 60_000, 'the secret to clear');
    await wait(4000);

    // 10 -----------------------------------------------------------------------------------------------
    d.showTab('hide');
    choose('mode', 'qr');
    choose('anim-pick', 'footsmash');
    say('Other styles: a QR code. A phone camera scans it and opens this page with the secret ready for the passphrase. A fake QR code scans as a harmless decoy while the real secret hides inside it.', $('mode'));
    await wait(6000);
    press('btn-create');
    await until(() => !$('out-wrap').hidden && !$<HTMLButtonElement>('btn-create').disabled, 60_000, 'the QR code');
    highlight($('out-canvas'));
    await wait(8000);

    // 11 -----------------------------------------------------------------------------------------------
    d.showTab('keys');
    say('Public keys: no passphrase has to be shared. Each person makes a key once. The private half stays on their device, locked by a passphrase. The public half is safe to give to anyone.', $('panel-keys'));
    await wait(8000);
    $<HTMLDetailsElement>('key-make').open = true;
    highlight($('key-make'));
    await typeInto($<HTMLInputElement>('key-label'), KEY_NAME);
    await typeInto($<HTMLInputElement>('key-pass'), KEY_PASS);
    await typeInto($<HTMLInputElement>('key-pass2'), KEY_PASS);
    const weak = $<HTMLInputElement>('key-weak');
    if (!$('key-weak-row').hidden) weak.checked = true;
    const passkeyTick = $<HTMLInputElement>('key-passkey');
    passkeyTick.checked = false; // a passkey needs a real device prompt, so it is only explained
    await wait(1500);
    press('key-create');
    await until(() => $('my-keys').querySelector('.keycard') !== null && !$<HTMLButtonElement>('key-create').disabled, 60_000, 'the key');
    const card = [...$('my-keys').querySelectorAll<HTMLElement>('.keycard')].find((c) => c.textContent?.includes(KEY_NAME)) ?? null;
    highlight(card);
    note('The key is made. Its nine-word fingerprint lets you check, by phone or in person, that nobody swapped the key. Share the public key as text, a QR code or a link.');
    await wait(9000);
    highlight(card?.querySelector<HTMLElement>('.passkeybox') ?? null);
    note('A key can also have a passkey (Windows Hello, a fingerprint, a face or a security key), so that a touch brings the passphrase back instead of typing it. That needs a real device prompt, so it is only explained here.');
    await wait(9000);

    // 12 -----------------------------------------------------------------------------------------------
    const pubText = card?.querySelector<HTMLInputElement>('input')?.value ?? '';
    d.showTab('hide');
    choose('mode', 'codeart');
    choose('anim-pick', 'footsmash');
    $<HTMLInputElement>('pass').value = '';
    fire($('pass'), 'input');
    $<HTMLDetailsElement>('to-keys').open = true;
    say('To send to someone, paste their public key here. No passphrase is typed at all.', $('to-keys'));
    await wait(4000);
    await typeInto($<HTMLInputElement>('to-input'), pubText);
    await wait(1500);
    press('to-add');
    await wait(2000);
    const self = document.getElementById('to-self') as HTMLInputElement | null;
    if (self) self.checked = false; // the tour's own recipient is the only one
    highlight($('to-list'));
    note('The recipient is added. You can add several, and the image opens for each of them.');
    await wait(5000);
    highlight($('btn-create'));
    press('btn-create');
    await until(() => !$('out-wrap').hidden && !$<HTMLButtonElement>('btn-create').disabled, 60_000, 'the image');
    highlight($('out-canvas'));
    note('The image is locked to the public key. Only the owner of the matching private key can open it.');
    await wait(7000);

    // 13 -----------------------------------------------------------------------------------------------
    say('The key owner opens it with their key\'s passphrase (the box is relabelled for this), not a shared secret.');
    if (!d.outputToReveal()) throw new Error('There was no image to load.');
    await wait(5000);
    highlight($('pass2'));
    await typeInto($<HTMLInputElement>('pass2'), KEY_PASS);
    await wait(2000);
    press('btn-reveal');
    await until(() => !$('stage-wrap').hidden, 30_000, 'the animation');
    highlight($('stage'));
    await until(() => !$('result').hidden, 90_000, 'the secret');
    await wait(7000);
    d.clearResult();

    // 14 -----------------------------------------------------------------------------------------------
    d.showTab('hide');
    say('That is the tour. There is more: hiding a picture itself, reading text from a photo, splitting a big secret across several images, up to four messages in one photo, camera scanning, and the Outlook add-in. Everything is explained in this Help panel.');
    highlight(null);
    await wait(10000);
  } catch (e) {
    if (!(e instanceof Stopped)) {
      text.textContent = e instanceof Error ? e.message : 'The tour stopped.';
      await new Promise((r) => setTimeout(r, 4000));
    }
  } finally {
    // put everything back, and take the tour's own key away
    highlight(null);
    d.clearResult();
    d.trimReveal(revealBefore);
    try {
      for (const k of await listKeys()) if (!keyIdsBefore.has(k.id)) await deleteKey(k.id);
      await refreshKeys();
    } catch {
      /* nothing to clean up */
    }
    for (const [id, v] of saved) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = v as boolean;
      else el.value = v as string;
      fire(el, el.tagName === 'SELECT' ? 'change' : 'input');
    }
    for (const id of ['key-label', 'key-pass', 'key-pass2', 'to-input']) $<HTMLInputElement>(id).value = '';
    $<HTMLInputElement>('key-passkey').checked = false;
    $<HTMLInputElement>('pass').type = passWasHidden ? 'password' : 'text';
    $('pass-toggle').textContent = passWasHidden ? 'Show' : 'Hide';
    $<HTMLDetailsElement>('more-opts').open = moreWasOpen;
    $<HTMLDetailsElement>('to-keys').open = toKeysWasOpen;
    clearRecipients();
    $('hide-status').textContent = '';
    $('out-wrap').hidden = true;
    $('stage-wrap').hidden = true;
    bar.remove();
    running = false;
    d.showTab('hide');
  }
}
