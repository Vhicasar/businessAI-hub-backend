/**
 * BusinessHub AI — website live chat widget (vanilla JS, no dependencies).
 *
 * Embed:
 *   <script src="https://YOUR_API_HOST/widget.js"
 *           data-account="CHANNEL_ACCOUNT_ID"
 *           data-color="#4f46e5"
 *           data-title="Chat with us"></script>
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var ACCOUNT = script.getAttribute('data-account');
  var COLOR = script.getAttribute('data-color') || '#4f46e5';
  var TITLE = script.getAttribute('data-title') || 'Chat with us';
  var BASE = script.src.replace(/\/widget\.js.*$/, '');
  if (!ACCOUNT) return console.warn('[BusinessHub] widget: data-account missing');

  var visitorId = null;
  try { visitorId = localStorage.getItem('bh_visitor_' + ACCOUNT); } catch (e) { /* private mode */ }
  var lastSeen = null;
  var open = false;
  var pollTimer = null;

  // ---------- styles ----------
  var css =
    '.bhw-btn{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;' +
    'background:' + COLOR + ';color:#fff;border:none;cursor:pointer;font-size:24px;z-index:99999;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.25)}' +
    '.bhw-panel{position:fixed;bottom:88px;right:20px;width:330px;max-width:calc(100vw - 32px);' +
    'height:440px;max-height:70vh;background:#fff;border-radius:14px;z-index:99999;display:none;' +
    'flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28);' +
    'font-family:-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.bhw-panel.open{display:flex}' +
    '.bhw-head{background:' + COLOR + ';color:#fff;padding:13px 16px;font-weight:600;font-size:14px}' +
    '.bhw-msgs{flex:1;overflow-y:auto;padding:12px;background:#f4f5f7;display:flex;' +
    'flex-direction:column;gap:8px}' +
    '.bhw-m{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;' +
    'white-space:pre-wrap;word-break:break-word}' +
    '.bhw-m.in{background:' + COLOR + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.bhw-m.out{background:#fff;color:#172b4d;align-self:flex-start;border:1px solid #dfe1e6;' +
    'border-bottom-left-radius:4px}' +
    '.bhw-form{display:flex;border-top:1px solid #dfe1e6;background:#fff}' +
    '.bhw-input{flex:1;border:none;outline:none;padding:12px;font-size:13px}' +
    '.bhw-send{border:none;background:none;color:' + COLOR + ';font-weight:700;cursor:pointer;' +
    'padding:0 14px;font-size:13px}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- dom ----------
  // Tolerate placement in <head>: defer mounting until the body exists.
  function whenBodyReady(fn) {
    if (document.body) return fn();
    document.addEventListener('DOMContentLoaded', fn);
  }

  var btn = document.createElement('button');
  btn.className = 'bhw-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.textContent = '💬';

  var panel = document.createElement('div');
  panel.className = 'bhw-panel';
  panel.innerHTML =
    '<div class="bhw-head">' + TITLE + '</div>' +
    '<div class="bhw-msgs"></div>' +
    '<form class="bhw-form">' +
    '<input class="bhw-input" placeholder="Type a message…" maxlength="2000" autocomplete="off">' +
    '<button class="bhw-send" type="submit">Send</button></form>';

  whenBodyReady(function () {
    document.body.appendChild(btn);
    document.body.appendChild(panel);
  });

  var msgsEl = panel.querySelector('.bhw-msgs');
  var formEl = panel.querySelector('.bhw-form');
  var inputEl = panel.querySelector('.bhw-input');

  function render(messages) {
    messages.forEach(function (m) {
      var el = document.createElement('div');
      // INBOUND = visitor’s own message (they are the "customer" side)
      el.className = 'bhw-m ' + (m.direction === 'INBOUND' ? 'in' : 'out');
      el.textContent = m.body || '';
      msgsEl.appendChild(el);
      lastSeen = m.createdAt;
    });
    if (messages.length) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    // Bypass ngrok free-plan browser interstitial for API calls.
    opts.headers['ngrok-skip-browser-warning'] = '1';
    return fetch(BASE + '/api/webchat/' + ACCOUNT + path, opts).then(function (r) {
      return r.json();
    });
  }

  function ensureSession() {
    if (visitorId) return Promise.resolve();
    return api('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(function (json) {
      if (json && json.success) {
        visitorId = json.data.visitorId;
        try { localStorage.setItem('bh_visitor_' + ACCOUNT, visitorId); } catch (e) { /* ignore */ }
      }
    });
  }

  function poll() {
    if (!visitorId) return;
    var q = '?visitorId=' + encodeURIComponent(visitorId) +
      (lastSeen ? '&after=' + encodeURIComponent(lastSeen) : '');
    api('/messages' + q, {}).then(function (json) {
      if (json && json.success) render(json.data.messages);
    }).catch(function () { /* transient */ });
  }

  btn.addEventListener('click', function () {
    open = !open;
    panel.classList.toggle('open', open);
    btn.textContent = open ? '✕' : '💬';
    if (open) {
      ensureSession().then(poll);
      if (!pollTimer) pollTimer = setInterval(poll, 4000);
      inputEl.focus();
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    ensureSession().then(function () {
      api('/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: visitorId, text: text }),
      }).then(poll);
    });
  });
})();
