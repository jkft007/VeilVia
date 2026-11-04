# VeilVia messaging

Turn any text into an image you can paste into a message or email. Only someone with the passphrase can turn it back. Runs entirely in the browser; nothing is uploaded.

The product name is **VeilVia**: [source](https://github.com/jkft007/VeilVia) and [live site](https://jkft007.github.io/VeilVia/).

## How to use
**Sending** (simple by default)
1. Choose **Text**, **File** or **Image** and add the secret.
2. Enter a **recipient passcode** (at least five unrelated words is a good starting point, not a short PIN). A strong passphrase is generated automatically; the passcode unlocks the secret without needing to share that generated passphrase. Security is limited by the passcode's strength.
3. Pick the **packaging**: code art, QR code, fake QR code or hidden in a photo. Photos use the JPEG-safe method; choose your own cover or let the app generate one. Optionally select a sender signing key.
4. Press **Create image & copy**. The image(s) and reveal link are copied automatically; paste into an email or chat and share the passcode separately. If the browser blocks copying, use **Copy message** or download the images and send the displayed reveal link. Large secrets are split automatically; send every image.

**Advanced user** opens the full existing controls without clearing your text, file, packaging or signing choice. Simple sending ignores advanced recipients, extra messages and custom reveal settings; switching back restores those controls. Fake QR packaging in simple sending uses the recipient passcode to locate its hidden data as well as unlock the generated passphrase's key slot.

**Sending with advanced controls**
1. Type or paste your text (or choose a file, paste a picture, or read the text from a camera photo) and enter a passphrase, or press **Generate**.
2. Pick an **image style**: code art, QR code, fake QR code, or hidden in a photo (JPEG-safe or lossless), and optionally your own cover photo.
3. Optionally open **More options**: a reveal animation (one of 84), a reading time, an expiry from 1 minute to 30 days, and a recipient pass code. With the photo style, **More messages in this photo** adds up to 3 more messages, each with its own passphrase and optional pass code.
4. Press **Create image**, then **Copy message** (the image, a link to the site and, for code art and QR, a direct link to the secret) and paste it into an email or chat, or download the image. Give the passphrase to your recipient by a different route.

**Receiving**
1. Open the link, use the **Reveal secret** button of the Outlook add-in, or use the **Reveal a secret** tab: paste, drop or choose the image, or scan a QR code with the camera. If the secret was split, add every part.
2. Type the passphrase (or the pass code) and press **Reveal**. If the secret was sent to your public key, the box changes to **Your key's passphrase**: type the passphrase you chose when you made your key (it is not a shared secret). Your key must be saved on this device, or restored first from its backup in the **My keys** tab. Watch the animation (or **Skip**), read the secret, copy it or save the file. It self-destructs after the reading time: when the time is up the revealed text goes up in a puff of smoke on screen and a vortex sucks it away, and the extracted text and any picture are swallowed with it. (**Clear now** clears at once.)

## Public keys (no shared passphrase)
A passphrase has to reach your recipient by some other safe route. Public keys remove that step, and sit alongside the passphrase option rather than replacing it.
- **Make a key** (once, in the **My keys** tab, where all key management lives: your keys, contacts and restoring a backup). The browser makes a key pair: the private half stays on your device, locked by a passphrase you choose (Argon2id + AES-GCM); the public half is a short text (`stpub1:…`), a QR code, or a "send me a secret" link that you can post anywhere.
- **Send to a key**: on the Hide tab open **Send to a public key instead**, paste the person's public key (or open their link) and create the image as usual. You can add several recipients, and a passphrase as an extra way in. Nobody has to share anything first.
- **Open it**: the recipient reveals the image and types the passphrase of their own key, the one they chose when they made it (it is not a shared secret). When the image is addressed to a public key, the Reveal box is relabelled **Your key's passphrase** to say so (photos cannot be recognised until they are opened, so they keep the general label and a reminder under the box). Their saved key opens it; on a new device they restore the key from its backup first.
- **Passkey for your key (optional).** Press **Generate** when you make the key to fill in a long random passphrase (and tick the passkey box), so a passkey brings it back and nobody has to remember it; copy it somewhere safe too. Tick **Also keep the passphrase safe with a passkey** when you make the key, or press **Add passkey** in the key's card later (you type the key's passphrase once). A passkey (Windows Hello, a fingerprint or face, or a security key, through the WebAuthn "PRF" extension) then keeps the passphrase safe and hands it back, so the **Reveal with passkey** button on the Reveal tab opens your key without typing anything. The passphrase still works. A passkey belongs to the device that made it, so it is not part of the backup, and not every browser or authenticator supports it.
- **Check the key first.** Each key has a fingerprint of nine words (for example `rhubarb engine fox · rocket raven pebble · lagoon bread rain`, 72 bits). Compare them with the owner by a call or in person, so you know nobody swapped the key. Contacts you name are saved on the device.
- **Back the key up.** The backup file is still locked by its passphrase. If the browser's data is cleared and there is no backup, anything sent to that key is lost for good.
- **How it works.** The image's content key is wrapped for each recipient with ECDH against a throwaway key (X25519, or P-256 in browsers that lack it) and HKDF, then AES-256-GCM; every recipient, and the optional passphrase, gets a slot in a version 4 packet header, all authenticated. The packet does not say who it is for. Everything else (reveal animation, expiry, reading time, splitting, QR links, the Outlook add-in) works as before. Fake QR codes and the recipient pass code are not combined with public keys; photos are, with the hidden position derived from the recipient's public key, so a photo hides the message less secretly than it does with a passphrase.
- The sender cannot re-read their own message afterwards (the throwaway key is discarded); tick **Also lock it to my own key** if you need to.

## Sender signatures (Ed25519)
Encryption to a public key does **not** identify a sender: anyone can encrypt to it. Unsigned messages now show an explicit warning.

1. In **My keys**, make a key with purpose **Sign messages (Ed25519)**. It is separate from your encryption key, protected by a passphrase, and can be backed up and restored with the same controls. Share its public half and compare its fingerprint with recipients through a trusted channel.
2. On the Hide tab, open **Sign as a sender**, select that key and enter its passphrase. Under **Who can see the signing key?**, choose a **public signature** (the existing default) or **Only someone who can decrypt (encrypted signature)**. Public signatures cover the complete encrypted packet. Encrypted signatures bind the payload, settings and complete encryption header, including recipient slots, then put the signing key and signature inside the encryption. Choose encrypted signatures for photos when sender privacy matters. Both work with texts, files, every image style, multiple messages in a photo and split images. Failure to unlock or sign never falls back to sending unsigned.
3. Recipients save your Ed25519 public key under **Add a sender's signing key**, compare its displayed fingerprint with you by a trusted call or in person, then mark the words checked. Merely saving a name or receiving a valid signature does not establish trust.
4. On Reveal, a checked signing key is labelled **Verified sender**. Other valid signatures say **unknown sender**, and absent signatures say **Unsigned message**. Select **Require a verified sender** to reject messages that are unsigned or signed by someone else, including messages whose signature wrapper was removed.

Invalid signatures are refused before any secret is shown, read aloud or offered for download. Public signatures are verified before decryption; encrypted signatures are verified immediately after decryption, before decompressing or interpreting the secret. Required-sender enforcement applies to both. Public signatures use format version 5 and add 108 bytes. Encrypted signatures use format version 6 and add 97 bytes; their header identifies the encryption format (versions 1..4), while the encrypted plaintext holds the 32-byte signing key, 64-byte signature and compressed payload. The private signature has a separate domain and binds that header, signing key and payload. Older unsigned and publicly signed messages remain readable, but older app versions cannot read version 6. Ed25519 requires browser support; it does not silently substitute another algorithm.

Public signing exposes the signing key to anyone who extracts the packet. Encrypted signing hides the sender's key from people who cannot decrypt, but the packet format still indicates that an encrypted signature is present. Anyone with the shared passphrase, passcode or a recipient private key can see the signing key and signature and could disclose them; this is not deniable authentication or a guarantee that a photo contains no detectable message. Neither signature mode prevents replay or proves that a sender's key has not been stolen, and there is no key-revocation service: remove trust from a compromised key and check its replacement out of band.

## Image styles
- **Code art**: a colourful mosaic that survives JPEG compression, resizing and screenshots.
- **QR code**: a standard QR holding a link to this page with the encrypted data in the part after `#` (which browsers never send to a server). Scan it with an ordinary phone camera and the page opens on the Reveal tab with the secret already loaded; the recipient only types the passphrase, and the address bar is tidied so the data does not stay in it. Best for short secrets (one QR holds roughly 1.6 KB of encrypted data). With several parts each QR opens its own page, so use **Scan QR with camera** inside the app for those. QR codes made by earlier versions (raw base64) still read. The link points at whichever site made the code, so codes made on a local test copy only work on that copy.
- **Fake QR code**: scans as a decoy you choose (e.g. a web link). The real secret is hidden in the QR's error-correction budget and is only recovered with the passphrase.
- **Hidden in a photo**:
  - *JPEG-safe* (default): bits stored in DCT coefficients with heavy redundancy and error correction. Survives normal JPEG recompression (about quality 50+), not cropping, rotation or resizing.
  - *Lossless*: LSB embedding, more capacity, but only survives as an original PNG.
  - Either method can hold **up to 4 messages**, each with its own passphrase and optional pass code, in one photo (see "Several messages in one photo" below).

**Copy message (image + link)** puts the image, the link to this site and a short explanation on the clipboard (as rich text plus plain text and a PNG) so you can paste it straight into an email or chat. For code art and QR images (one image, short enough) the message also includes a **link that opens the secret directly**, for email programs that hide images or block remote content: the recipient clicks it and only types the passphrase. The encrypted data sits after the `#` in that link, which browsers never send to a server; the passphrase is not in it. Photo and fake-QR images never get such a link, because they exist to hide that a secret is there at all.

Encryption: AES-256-GCM, key from the passphrase via Argon2id (64 MiB, 3 passes), Reed-Solomon error correction. The reveal is animated, with 84 styles (thirteen that show the image or QR code and then destroy it), leaving the message in the middle. The sender can pick one when creating the image: the choice is stored inside the encrypted data, so only the passphrase holder can see it, and it is played when the recipient reveals the secret. The recipient can still override it from the animation menu, and images with no choice get a random one. The sender can also disable animation when creating the image.

## Files and documents
Choose **File or document** on the Hide tab to hide a PDF, spreadsheet, key file, zip or anything else instead of text. The file name and contents are both encrypted, and the recipient gets a **Save file** button (files are never opened automatically; executable-type files get an extra warning). Rough size limits per style: lossless photo ~400 KB, code art ~58 KB (images get big above 8 KB), JPEG-safe photo ~3 KB, QR ~1.6 KB, fake QR ~350 bytes. The app shows the limit for the chosen style and refuses oversize files.

## Hiding a picture itself
In **File or document** mode you can paste an image from the clipboard (Ctrl/Cmd+V, or **Paste an image from the clipboard**) and the picture itself is encrypted and hidden, byte for byte, instead of its text being read. The recipient sees a preview of the revealed picture, with **Save file** and **Copy image** buttons. Pictures are usually large, so the lossless photo style (or splitting across several images) is the practical way to carry them.

## Reading the secret from a picture of text
On the Hide tab (text mode), **Use camera**, **Choose image** or **Paste image** reads the text out of a picture (a note, a printed password, a page) and puts it in the secret box for you to check and edit before hiding. It runs entirely in the browser with [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0, English). The reader (about 7 MB) is served from this site's own files and downloaded only the first time you use it. Printed text works best; handwriting does not.

## Splitting across several images
If a secret does not fit in one image, it is encrypted once and cut into numbered parts (up to 60), each in its own image of the chosen style. On the Reveal tab, add all the images in any order (paste, drop, choose, or scan QR codes one after another); the app says exactly which parts are missing. **Copy message** puts every image plus the link into one rich-text clipboard entry for email; chat apps that take one image at a time can use each part's own Copy button.

## Camera scanning
**Scan QR with camera** (Reveal tab) reads QR and fake-QR codes live, including tilted or angled ones, using a perspective transform. Plain QR needs no passphrase to scan; for a fake QR, type the passphrase first or while scanning. Needs https or localhost and camera permission. Only the QR modes can be scanned: code art and photos need a clean image, not a camera view.

## Cover photos
Choose a file, or paste one from the clipboard (Ctrl/Cmd+V on the Hide tab with the photo style selected, or the **Paste cover from clipboard** button). JPEG, PNG and iPhone **HEIC/HEIF** photos work as cover images. HEIC is decoded in the browser with [libheif-js](https://github.com/catdad-experiments/libheif-js) (WebAssembly, LGPL-3.0), loaded only when a HEIC file is picked. Output is always PNG or JPEG-safe pixels, never HEIC.

## In email, and the Outlook add-in
Email programs do not run scripts, so no image or message can decrypt itself inside an email. Two things get close:
- **Direct link.** The **Copy message** text for a code art or QR image includes a link that opens the secret on this site (see above); the recipient clicks it and types the passphrase.
- **Outlook add-in** (`public/outlook/`; the manifest link and install steps are also on the site's landing page). A **Reveal secret** button on the message toolbar opens a task pane beside the email (pin it with the pin icon and it follows you from email to email; an Outlook cannot draw inside the message body itself). The pane looks in the open email for image attachments (pasted inline pictures count) or a VeilVia messaging link, loads what it finds into this app (shown inside the pane), and the recipient types the passphrase. Decryption runs in the pane on the recipient's device. It asks Outlook only for permission to read the open email, and it only takes the data after `#q=` from a link (the link itself is never followed). Photo and fake-QR images are found the same way, from the attachment.

  To install it (Outlook on the web, new Outlook, or classic Outlook with Microsoft 365): **Get Add-ins → My add-ins → Add a custom add-in → Add from URL**, and give it `https://jkft007.github.io/VeilVia/outlook/manifest.xml`. If your Outlook does not accept a link, use the **Download file** button on the site's Outlook section (or save the manifest link) and choose **Add from file**. A Microsoft 365 admin can instead upload the same manifest under **Integrated apps** to roll it out to a team. Needs a mailbox that supports Mailbox requirement set 1.8 (all current Outlook versions).

  Honest caveats: the pane page loads Microsoft's `office.js` from Microsoft's own server (Outlook requires it; the main app loads no third-party script). The add-in was tested here with a stand-in for Outlook's email object, not inside a real Outlook, and some organisations block custom add-ins. If a mail program removes or rescales an image before it reaches the pane, the same limits as in the table above apply.

## Run

```
npm install
npm run dev     # http://localhost:5173
npm test
npm run build   # static site in dist/
```

## Protection against guessing
Because everything runs in the browser, anyone who copies an image can guess passphrases offline, and no web page can rate-limit that. What the app does about it:
- **Argon2id key derivation** (memory-hard: 64 MiB per guess), so mass guessing on GPUs or custom hardware is expensive. The parameters are stored in each image's authenticated header; older PBKDF2 images still open.
- **No cheap shortcut.** In the photo and fake-QR styles, where the data hides depends on the passphrase and could be checked without decrypting. That position key is derived with the same memory-hard function, so it costs as much to guess as the encryption key. Images made before this change still open through a fallback.
- **Passphrase strength gate.** Weak passphrases (common passwords, patterns, short or repetitive ones, famous word phrases) are refused unless you tick "Use it anyway". The Generate button makes a 99-bit random one.
- **Lockout on this device.** After 4 wrong passphrases on the same images, further tries are delayed (5 s, then doubling up to 5 min). This only frustrates casual guessing at the keyboard; it cannot stop offline attacks, so a strong passphrase is still what matters.

## No animation, and what is left behind
In **More options** the sender can tick **No nonsense: just show the message (no animation)**: the choice is sealed inside the encrypted image, and the recipient's browser then shows the message at once. When the reading time runs out the message goes up in smoke and a vortex takes it, and a doodle with a long nose is left peeking over a wall with "WALLY WAS HERE" chalked on it.

## Reading aloud
On the Reveal tab the revealed text can be read aloud: tick **Read it aloud** before pressing Reveal, or press **🔊 Read aloud** (and **Stop reading**) beside the secret. It uses the browser's own speech and only voices that run on your device: some browsers' online voices send the text to a server to be spoken, so those are never used, and if there is no on-device voice the feature is switched off. The voice stops when the reading time ends or the secret is cleared. Mind who can hear it.

## Demo
The **? Help** button has a **Watch the demo** button: a slow, guided tour that runs the real app on a demo secret, with captions, a highlight on what it is using, and Pause and Stop buttons. It types a secret, generates a passphrase, picks the options, makes a code-art image and opens it (a wrong passphrase first, then the right one, with an animation and the burn-away), makes a QR code, then makes a temporary key, sends a secret to its public key and opens it with the key's passphrase. It uses the non-photo styles, removes its temporary key afterwards and puts your fields back. The passkey is only explained, because it needs a real device prompt.

## How it works
1. **Encrypt.** The browser turns your passphrase into a key with Argon2id and encrypts the secret (text, a file, or a pasted picture) with AES-256-GCM. The settings you choose (reveal animation, reading time, expiry) are sealed inside the same encrypted data, so only the passphrase holder can read them. Instead of a shared passphrase the image can be locked to one or more **public keys** (see Public keys above): the same random image key is then wrapped once for each recipient, so only the holder of a matching private key can open it. An optional recipient pass code gets its own way in: the image key is wrapped under a key derived from the pass code (a key slot in code art and QR images, a small locator record in photos).
2. **Hide.** The encrypted bytes, with Reed-Solomon error correction, are drawn into an image: a code-art mosaic, a QR code (a phone camera opens this page with the image ready), a fake QR (it scans as a decoy), or an ordinary-looking photo. Photo data is scattered across positions that only the passphrase reveals, and one photo can carry up to 4 messages in separate lanes. A secret too big for one image is split across up to 60.
3. **Send.** The image travels like any picture: pasted, attached, or scanned from a QR code.
4. **Reveal.** The recipient adds the image on the Reveal tab (paste, drop, choose, camera or a QR link) and types the passphrase or pass code (or, for an image sent to their public key, the passphrase of their key, or uses a passkey). The browser finds the data, checks it, decrypts it, enforces any expiry, plays the sender's chosen animation (or the recipient's own pick) and shows the text, which clears itself after the reading time. All of this happens in the browser; nothing is uploaded.

## When to use it
- **Good for:** a password, API key, recovery phrase or private note sent over a channel you do not fully trust, when the passphrase travels by a different route. Also for hiding text in plain sight inside a photo.
- **Not for:** anything that must stay safe against someone who holds the image and can guess the passphrase (they can guess offline indefinitely), long-term storage (there is no recovery for a forgotten passphrase), or replacing an end-to-end encrypted messenger or a password manager.

## Which apps keep the image intact
It depends on whether an app delivers the image as it is, or re-compresses and shrinks it like a photo.

| How the image travels | Code art, QR, fake QR | Photo, JPEG-safe | Photo, lossless |
| --- | --- | --- | --- |
| Sent as a file (email attachment, "send as file/document" in chat apps, cloud-drive link) | Yes | Yes | Yes |
| Re-compressed as JPEG at the same size | Yes (tested to JPEG quality 50) | Yes (tested to quality 50) | No |
| Shrunk, as many chat apps do to photos | Code art: yes (tested at 60% plus JPEG). QR / fake QR: usually, while still big enough to scan (not tested) | No | No |
| Screenshot of the whole image | Yes | Usually, if not scaled | Only if exact pixels |
| Cropped, rotated, or only part of it | No | No | No |

Attachments and "send as file/document" options generally deliver the original. Sending as a normal photo in most chat and social apps (WhatsApp, iMessage, Messenger, Instagram, Telegram or Signal in photo mode) re-compresses and may shrink it, so use Code art or a JPEG-safe photo there. Apps differ and change between versions and have not all been tested: send yourself a test image first. "Tested" above refers to the automated tests in `tests/`, which simulate JPEG recompression and scaling in code, not real apps.

## Expiry (optional)
The Hide tab can set the secret to expire in 1, 5, 15 or 30 minutes, or in 1 hour, 24 hours, 7 days or 30 days. The expiry time is stored inside the encrypted payload (so it cannot be read or edited without the passphrase, and it is covered by the same authentication as the rest) and the Reveal step refuses to show the secret after it. A wrong passphrase learns nothing about the expiry.

What this is not: it is enforced by this app and the recipient's clock, not by cryptography or a server. Someone who has the passphrase can copy the secret before it expires, change their clock, or decrypt the image with other software. Treat it as a courtesy that limits accidental late reads, not as a way to make a leaked image safe.

## Recipient pass code (optional)
The Hide tab can also take a **recipient pass code**. The image's encryption key is then stored inside the image too, locked by a key derived from the pass code (a second key slot, 76 bytes; the packet becomes version 3). The recipient types either the passphrase or the pass code on the Reveal tab. This lets you give the recipient only the pass code and keep the master passphrase to yourself, or press Generate for a random passphrase you never need to share.

In a photo, a message's position comes from its passphrase, so a pass code cannot find it directly. A photo therefore gets a tiny second record (a "locator", about 92 bytes) hidden at positions derived from the pass code; it holds the passphrase, encrypted under a second key from the pass code. Pass code, then locator, then passphrase, then message. This costs a few percent of the photo's room per pass code, and the passphrase must be at most 63 bytes. Photo packets carry no key slot; the locator does that job. A **fake QR code** cannot take a pass code (the app refuses the combination), and its images always need the main passphrase.

It is not extra protection: either one opens the image, so the image is only as strong as the weaker of the two. The pass code goes through the same strength check as the passphrase and the same Argon2id cost per guess. The slot is part of the authenticated header, so editing it breaks both ways in.

## Several messages in one photo
With the photo style, **More messages in this photo** hides up to 4 messages in one image, each with its own passphrase and optional pass code. Whoever types a passphrase or pass code sees only that message, and nothing in the image says how many there are. The photo's slots are divided into non-overlapping lanes; each message is scrambled across its own lane by a key from its passphrase, and each pass code's locator sits in a small lane of its own. The decoder tries every lane layout (at most 20) with the key it was given. The more messages, the less room each has (roughly an equal share of the photo, so a bigger cover photo helps), and all passphrases and pass codes in one photo must differ. The animation, reading time and expiry settings apply to every message, and extra messages are text only and are not combined with splitting. Existing single-message photos are read exactly as before.

## Reading time (optional)
The Reveal tab clears the revealed secret from the screen after a countdown (1 minute by default). The sender can set a different **reading time** (10 s to 15 min, or until cleared by hand) when creating the image; it is stored inside the encrypted data. The recipient can shorten it from the "Clear" menu but not stretch it. This only clears the screen: it cannot stop the recipient copying the text first.

## Limits
- Use a long random passphrase: anyone holding the image can guess offline. The image size hints at the message length.
- Fake QR hides the message from casual scanning, not from analysis: a forensic tool would see far more corrected errors than a normal QR has.
- Cropped, rotated or heavily resized image files cannot be decoded (QR codes seen by the camera are the exception).

## License

MIT
