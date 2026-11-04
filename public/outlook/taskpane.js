// Outlook task pane: finds the secret in the open email and hands it to the app in the frame below.
// It reads the message's image attachments (inline pictures count) and any VeilVia messaging link in the
// text, and sends them to the frame with postMessage. Nothing is uploaded; decryption happens in the app.
(function () {
  var frame = document.getElementById('app');
  var msg = document.getElementById('msg');
  var MAX_BYTES = 12 * 1024 * 1024;
  var LINK = /https?:\/\/[^\s"'<>]+#q=([A-Za-z0-9_-]+)/;

  function say(text, isError) {
    msg.textContent = text;
    msg.className = isError ? 'err' : '';
  }

  // A fresh query string forces a full reload, so the app starts clean for every email.
  function loadApp(hash) {
    return new Promise(function (resolve) {
      frame.addEventListener('load', function () { resolve(); }, { once: true });
      frame.src = '../index.html?m=' + Date.now() + hash;
    });
  }

  function base64ToBuffer(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function textOf(item) {
    return new Promise(function (resolve) {
      if (!item.body || !item.body.getAsync) return resolve('');
      var kind = window.Office && Office.CoercionType ? Office.CoercionType.Text : 'text';
      item.body.getAsync(kind, function (r) { resolve(r && r.status === 'succeeded' ? String(r.value || '') : ''); });
    });
  }

  function contentOf(item, att) {
    return new Promise(function (resolve) {
      item.getAttachmentContentAsync(att.id, function (r) {
        if (!r || r.status !== 'succeeded' || !r.value || r.value.format !== 'base64') return resolve(null);
        resolve(base64ToBuffer(r.value.content));
      });
    });
  }

  function isImage(att) {
    var fileType = !att.attachmentType || String(att.attachmentType).toLowerCase() === 'file';
    return fileType && (/^image\//i.test(att.contentType || '') || /\.(png|jpe?g|heic|heif|webp|gif|bmp)$/i.test(att.name || ''));
  }

  var token = 0; // a newer email replaces an older one still being read
  async function run(item) {
    var mine = ++token;
    if (!item) return say('Open this pane on an email.', true);
    say('Looking for a secret in this email…');

    // A direct link: only the data after #q= is taken and loaded into our own page; the link itself is never followed.
    var link = LINK.exec(await textOf(item));
    if (mine !== token) return;
    if (link) {
      await loadApp('#q=' + link[1]);
      if (mine !== token) return;
      return say('Found a secret link in this email. Type the passphrase below.');
    }

    await loadApp('#reveal');
    if (mine !== token) return;
    var atts = (item.attachments || []).filter(isImage);
    var sent = 0;
    for (var i = 0; i < atts.length; i++) {
      var a = atts[i];
      if (a.size && a.size > MAX_BYTES) continue;
      var buf = await contentOf(item, a);
      if (mine !== token) return;
      if (!buf) continue;
      frame.contentWindow.postMessage({ type: 'st-image', mime: a.contentType || '', bytes: buf }, location.origin, [buf]);
      sent++;
    }
    if (sent) say('Found ' + sent + ' image' + (sent > 1 ? 's' : '') + ' in this email. Type the passphrase below.');
    else say('No image or secret link found in this email. You can still paste or drop an image below.');
  }

  // For tests.
  window.__stBridge = { run: run };

  if (window.Office && Office.onReady) {
    Office.onReady(function (info) {
      if (!info || !info.host) return say('Open this pane from Outlook, on an email.', true);
      var mailbox = Office.context.mailbox;
      run(mailbox.item);
      // A pinned pane stays open while the reader moves to other emails.
      if (mailbox.addHandlerAsync && Office.EventType && Office.EventType.ItemChanged) {
        mailbox.addHandlerAsync(Office.EventType.ItemChanged, function () { run(mailbox.item); });
      }
    });
  } else {
    say('Office.js did not load, so this pane can only run inside Outlook.', true);
  }
})();
