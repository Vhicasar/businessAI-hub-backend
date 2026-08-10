/**
 * Vhicasar Hub AI — website live chat widget (vanilla JS, no dependencies).
 *
 * Embed:
 *   <script src="https://YOUR_API_HOST/widget.js"
 *           data-account="CHANNEL_ACCOUNT_ID"></script>
 *
 * Branding (theme colour, title, greeting, logo) is fetched from the business's
 * Vhicasar Hub workspace automatically, so it always matches their brand — the
 * platform primary is orange (#F97316). The optional data-color / data-title
 * attributes still override the fetched values when set.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var ACCOUNT = script.getAttribute('data-account');
  var BASE = script.src.replace(/\/widget\.js.*$/, '');
  if (!ACCOUNT) return console.warn('[Vhicasar Hub] widget: data-account missing');

  // Config resolves from data-* attributes first, then the fetched branding,
  // then these platform defaults (orange).
  var cfg = {
    color: script.getAttribute('data-color') || '',
    title: script.getAttribute('data-title') || '',
    greeting: script.getAttribute('data-greeting') || '',
    businessName: '',
    logoUrl: '',
    appointments: false,
    showPoweredBy: true,
    poweredBy: { name: 'Vhicasar Hub AI', logoUrl: '', url: '' },
  };
  var DEFAULT_COLOR = '#F97316';

  var visitorId = null;
  try { visitorId = localStorage.getItem('bh_visitor_' + ACCOUNT); } catch (e) { /* private mode */ }
  var lastSeen = null;
  var open = false;
  var pollTimer = null;
  var unread = 0;
  var greeted = false;
  var pollInFlight = false;
  var renderedMessageIds = Object.create(null);

  // ---------- helpers ----------
  // Readable text colour (black/white) for a given background, per WCAG luma.
  function readableOn(hex) {
    var c = (hex || '').replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    if (c.length !== 6) return '#fff';
    var r = parseInt(c.slice(0, 2), 16) / 255;
    var g = parseInt(c.slice(2, 4), 16) / 255;
    var b = parseInt(c.slice(4, 6), 16) / 255;
    var lin = function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.5 ? '#111827' : '#ffffff';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ---------- styles ----------
  function injectStyles(color) {
    var onColor = readableOn(color);
    var css =
      ':root{--bhw:' + color + ';--bhw-on:' + onColor + '}' +
      '.bhw-btn{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;' +
      'background:var(--bhw);color:var(--bhw-on);border:none;cursor:pointer;z-index:2147483000;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.28);' +
      'transition:transform .15s ease}' +
      '.bhw-btn:hover{transform:scale(1.06)}' +
      '.bhw-btn:focus-visible{outline:3px solid var(--bhw);outline-offset:3px}' +
      '.bhw-btn svg{width:26px;height:26px;fill:currentColor}' +
      '.bhw-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;' +
      'border-radius:10px;background:#ef4444;color:#fff;font:700 12px/20px -apple-system,Segoe UI,Roboto,sans-serif;' +
      'text-align:center;box-shadow:0 0 0 2px #fff}' +
      '.bhw-panel{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 32px);' +
      'height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;z-index:2147483000;' +
      'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.3);' +
      'opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;' +
      'transition:opacity .18s ease,transform .18s ease;' +
      'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}' +
      '.bhw-panel.open{opacity:1;transform:none;pointer-events:auto}' +
      '.bhw-head{background:var(--bhw);color:var(--bhw-on);padding:14px 16px;display:flex;align-items:center;gap:10px}' +
      '.bhw-logo{width:32px;height:32px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.25);flex:none}' +
      '.bhw-logo-fallback{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(255,255,255,.22);font-size:14px;font-weight:800;flex:none}' +
      '.bhw-htext{flex:1;min-width:0}' +
      '.bhw-title{font-weight:700;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.bhw-sub{font-size:12px;opacity:.85;display:flex;align-items:center;gap:5px}' +
      '.bhw-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block}' +
      '.bhw-close{background:none;border:none;color:inherit;cursor:pointer;padding:4px;border-radius:6px;line-height:0}' +
      '.bhw-close:hover{background:rgba(255,255,255,.18)}' +
      '.bhw-close:focus-visible{outline:2px solid var(--bhw-on);outline-offset:1px}' +
      '.bhw-close svg{width:20px;height:20px;fill:currentColor}' +
      '.bhw-msgs{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px}' +
      '.bhw-m{max-width:82%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.45;' +
      'white-space:pre-wrap;word-break:break-word}' +
      '.bhw-m.in{background:var(--bhw);color:var(--bhw-on);align-self:flex-end;border-bottom-right-radius:5px}' +
      '.bhw-m.out{background:#fff;color:#1f2937;align-self:flex-start;border:1px solid #e5e7eb;border-bottom-left-radius:5px}' +
      '.bhw-form{display:flex;align-items:center;border-top:1px solid #e5e7eb;background:#fff;padding:6px 6px 6px 4px}' +
      '.bhw-input{flex:1;border:none;outline:none;padding:12px;font-size:14px;background:transparent;color:#1f2937}' +
      '.bhw-send{border:none;background:var(--bhw);color:var(--bhw-on);cursor:pointer;width:40px;height:40px;' +
      'border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}' +
      '.bhw-send:disabled{opacity:.5;cursor:default}' +
      '.bhw-send:focus-visible{outline:2px solid var(--bhw);outline-offset:2px}' +
      '.bhw-send svg{width:18px;height:18px;fill:currentColor}' +
      '.bhw-foot{text-align:center;font-size:10px;color:#9ca3af;padding:5px 6px 7px;background:#fff}' +
      '.bhw-foot a{color:#1f2937;text-decoration:none;display:inline-flex;align-items:center;gap:0;vertical-align:middle}' +
      '.bhw-powered-logo{width:28px;height:28px;object-fit:contain}' +
      '.bhw-powered-word{font-size:12px;line-height:28px;font-weight:800;letter-spacing:-.025em;color:#1f2937}' +
      '.bhw-powered-ai{color:#F97316}' +
      '.bhw-book{background:none;border:1px solid rgba(255,255,255,.6);color:inherit;cursor:pointer;' +
      'font-size:12px;font-weight:600;border-radius:8px;padding:5px 9px;white-space:nowrap}' +
      '.bhw-book:hover{background:rgba(255,255,255,.16)}' +
      '.bhw-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;align-self:stretch}' +
      '.bhw-card h4{margin:0 0 6px;font-size:14px}' +
      '.bhw-daygrp{margin-top:8px}.bhw-daygrp>span{font-size:12px;color:#6b7280;font-weight:600}' +
      '.bhw-slots{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}' +
      '.bhw-slot{border:1px solid var(--bhw);color:var(--bhw);background:#fff;border-radius:8px;' +
      'padding:6px 10px;font-size:13px;cursor:pointer}.bhw-slot:hover{background:var(--bhw);color:var(--bhw-on)}' +
      '.bhw-field{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:9px;' +
      'font-size:14px;margin-top:8px}' +
      '.bhw-cta{width:100%;margin-top:10px;border:none;background:var(--bhw);color:var(--bhw-on);' +
      'border-radius:8px;padding:10px;font-weight:700;font-size:14px;cursor:pointer}' +
      '.bhw-cta:disabled{opacity:.5}' +
      '.bhw-link{display:inline-block;margin:4px 8px 0 0;color:var(--bhw);font-size:13px;text-decoration:none;font-weight:600}' +
      '@media (max-width:480px){.bhw-panel{bottom:0;right:0;width:100vw;max-width:100vw;height:100vh;' +
      'max-height:100vh;border-radius:0}.bhw-btn{bottom:16px;right:16px}}' +
      '@media (prefers-reduced-motion:reduce){.bhw-panel,.bhw-btn{transition:none}}';
    var style = document.createElement('style');
    style.setAttribute('data-bhw', '1');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- icons ----------
  var ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.4 1.3 4.5 3.4 6-.2 1-.8 2.3-1.8 3.3 1.6-.2 3.2-.8 4.5-1.7 1.2.4 2.5.6 3.9.6 5.5 0 10-3.6 10-8s-4.5-8-10-8z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z"/></svg>';

  // ---------- dom ----------
  function whenBodyReady(fn) {
    if (document.body) return fn();
    document.addEventListener('DOMContentLoaded', fn);
  }

  var btn = document.createElement('button');
  btn.className = 'bhw-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = ICON_CHAT + '<span class="bhw-badge" style="display:none"></span>';

  var panel = document.createElement('div');
  panel.className = 'bhw-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'Live chat');

  var badgeEl, msgsEl, formEl, inputEl, sendEl;

  function buildPanel() {
    panel.innerHTML =
      '<div class="bhw-head">' +
      (cfg.logoUrl
        ? '<img class="bhw-logo" src="' + esc(cfg.logoUrl) + '" alt="">'
        : '<span class="bhw-logo-fallback" aria-hidden="true">' + esc((cfg.businessName || 'V').charAt(0).toUpperCase()) + '</span>') +
      '<div class="bhw-htext">' +
      '<div class="bhw-title">' + esc(cfg.title || 'Chat with us') + '</div>' +
      '<div class="bhw-sub"><span class="bhw-dot"></span> We reply as soon as we can</div>' +
      '</div>' +
      (cfg.appointments ? '<button class="bhw-book" type="button">📅 Book</button>' : '') +
      '<button class="bhw-close" aria-label="Close chat">' + ICON_CLOSE + '</button>' +
      '</div>' +
      '<div class="bhw-msgs" role="log" aria-live="polite" aria-relevant="additions"></div>' +
      '<form class="bhw-form">' +
      '<input class="bhw-input" aria-label="Type your message" placeholder="Type a message…" maxlength="2000" autocomplete="off">' +
      '<button class="bhw-send" type="submit" aria-label="Send message" disabled>' + ICON_SEND + '</button>' +
      '</form>' +
      (cfg.showPoweredBy ? '<div class="bhw-foot">Powered by <a href="' + esc(cfg.poweredBy.url || BASE) +
        '" target="_blank" rel="noopener">' +
        '<span class="bhw-powered-word">Vhicasar</span>' +
        '<span class="bhw-powered-word bhw-powered-ai">&nbsp;Hub AI</span>' +
        '</a></div>' : '');

    msgsEl = panel.querySelector('.bhw-msgs');
    formEl = panel.querySelector('.bhw-form');
    inputEl = panel.querySelector('.bhw-input');
    sendEl = panel.querySelector('.bhw-send');
    badgeEl = btn.querySelector('.bhw-badge');

    panel.querySelector('.bhw-close').addEventListener('click', function () { toggle(false); });
    var bookBtn = panel.querySelector('.bhw-book');
    if (bookBtn) bookBtn.addEventListener('click', startBooking);
    var businessLogo = panel.querySelector('.bhw-logo');
    if (businessLogo) businessLogo.addEventListener('error', function () {
      var fallback = document.createElement('span');
      fallback.className = 'bhw-logo-fallback';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = (cfg.businessName || 'V').charAt(0).toUpperCase();
      businessLogo.replaceWith(fallback);
    });
    inputEl.addEventListener('input', function () { sendEl.disabled = !inputEl.value.trim(); });
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });
    formEl.addEventListener('submit', onSubmit);
  }

  // ---------- appointment booking ----------
  function apptApi(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['ngrok-skip-browser-warning'] = '1';
    return fetch(BASE + '/api/appointments/' + ACCOUNT + path, opts).then(function (r) { return r.json(); });
  }

  function fmtDay(iso) { return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }

  function startBooking() {
    var card = document.createElement('div');
    card.className = 'bhw-card';
    card.innerHTML = '<h4>Book an appointment</h4><div class="bhw-loading">Loading available times…</div>';
    msgsEl.appendChild(card);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    apptApi('/slots?days=14', {}).then(function (json) {
      if (!json || !json.success || !json.data.enabled || !json.data.slots.length) {
        card.querySelector('.bhw-loading').textContent = 'No times are available right now — please send us a message instead.';
        return;
      }
      renderSlots(card, json.data);
    }).catch(function () {
      card.querySelector('.bhw-loading').textContent = 'Could not load times. Please try again.';
    });
  }

  function renderSlots(card, data) {
    var byDay = {};
    data.slots.slice(0, 60).forEach(function (s) { (byDay[fmtDay(s.start)] = byDay[fmtDay(s.start)] || []).push(s); });
    var html = '<h4>Pick a time</h4>';
    Object.keys(byDay).forEach(function (day) {
      html += '<div class="bhw-daygrp"><span>' + esc(day) + '</span><div class="bhw-slots">';
      byDay[day].forEach(function (s, i) { html += '<button class="bhw-slot" data-start="' + esc(s.start) + '">' + esc(fmtTime(s.start)) + '</button>'; });
      html += '</div></div>';
    });
    card.innerHTML = html;
    card.querySelectorAll('.bhw-slot').forEach(function (b) {
      b.addEventListener('click', function () { showBookingForm(card, b.getAttribute('data-start'), data.types && data.types[0] ? data.types[0].id : undefined); });
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function showBookingForm(card, start, typeId) {
    card.innerHTML =
      '<h4>Confirm ' + esc(fmtDay(start)) + ' · ' + esc(fmtTime(start)) + '</h4>' +
      '<input class="bhw-field bhw-name" placeholder="Your name" maxlength="120">' +
      '<input class="bhw-field bhw-email" type="email" placeholder="Your email (for confirmation)" maxlength="200">' +
      '<button class="bhw-cta" disabled>Confirm booking</button>';
    var nameEl = card.querySelector('.bhw-name');
    var emailEl = card.querySelector('.bhw-email');
    var cta = card.querySelector('.bhw-cta');
    function validate() { cta.disabled = !(nameEl.value.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailEl.value.trim())); }
    nameEl.addEventListener('input', validate);
    emailEl.addEventListener('input', validate);
    cta.addEventListener('click', function () {
      cta.disabled = true; cta.textContent = 'Booking…';
      ensureSession().then(function () {
        return apptApi('/book', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start: start, typeId: typeId, name: nameEl.value.trim(), email: emailEl.value.trim(), visitorId: visitorId }),
        });
      }).then(function (json) {
        if (json && json.success) confirmBooked(card, json.data);
        else { cta.disabled = false; cta.textContent = 'Confirm booking'; card.insertAdjacentHTML('beforeend', '<div style="color:#ef4444;font-size:13px;margin-top:8px">' + esc((json && json.error && json.error.message) || 'That time was just taken.') + '</div>'); }
      }).catch(function () { cta.disabled = false; cta.textContent = 'Confirm booking'; });
    });
    setTimeout(function () { nameEl.focus(); }, 30);
  }

  function confirmBooked(card, appt) {
    card.innerHTML =
      '<h4>✅ Booked!</h4>' +
      '<div style="font-size:14px">' + esc(fmtDay(appt.start)) + ' at ' + esc(fmtTime(appt.start)) + '</div>' +
      '<div style="margin-top:6px">' +
      '<a class="bhw-link" href="' + esc(appt.calendar.google) + '" target="_blank" rel="noopener">Add to Google</a>' +
      '<a class="bhw-link" href="' + esc(appt.calendar.outlook) + '" target="_blank" rel="noopener">Add to Outlook</a>' +
      '<a class="bhw-link" href="' + esc(appt.icsUrl) + '">Download .ics</a>' +
      '</div>';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function setUnread(n) {
    unread = n;
    if (!badgeEl) return;
    badgeEl.textContent = n > 9 ? '9+' : String(n);
    badgeEl.style.display = n > 0 ? 'block' : 'none';
  }

  function render(messages) {
    messages.forEach(function (m) {
      if (m.id && renderedMessageIds[m.id]) return;
      if (m.id) renderedMessageIds[m.id] = true;
      var el = document.createElement('div');
      // INBOUND = visitor's own message (they are the "customer" side)
      el.className = 'bhw-m ' + (m.direction === 'INBOUND' ? 'in' : 'out');
      el.textContent = m.body || '';
      msgsEl.appendChild(el);
      lastSeen = m.createdAt;
      if (!open && m.direction !== 'INBOUND') setUnread(unread + 1);
    });
    if (messages.length) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function showGreeting() {
    if (greeted || !cfg.greeting) return;
    greeted = true;
    var el = document.createElement('div');
    el.className = 'bhw-m out';
    el.textContent = cfg.greeting;
    msgsEl.appendChild(el);
  }

  // ---------- api ----------
  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['ngrok-skip-browser-warning'] = '1';
    return fetch(BASE + '/api/webchat/' + ACCOUNT + path, opts).then(function (r) { return r.json(); });
  }

  function ensureSession() {
    if (visitorId) return Promise.resolve();
    return api('/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(function (json) {
      if (json && json.success) {
        visitorId = json.data.visitorId;
        try { localStorage.setItem('bh_visitor_' + ACCOUNT, visitorId); } catch (e) { /* ignore */ }
      }
    });
  }

  function poll() {
    if (!visitorId || pollInFlight) return;
    pollInFlight = true;
    var q = '?visitorId=' + encodeURIComponent(visitorId) +
      (lastSeen ? '&after=' + encodeURIComponent(lastSeen) : '');
    api('/messages' + q, {}).then(function (json) {
      if (json && json.success) render(json.data.messages);
    }).catch(function () { /* transient */ }).finally(function () { pollInFlight = false; });
  }

  function onSubmit(e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    sendEl.disabled = true;
    var clientMessageId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
    ensureSession().then(function () {
      api('/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: visitorId, text: text, clientMessageId: clientMessageId }),
      }).then(poll);
    });
  }

  function toggle(next) {
    open = next == null ? !open : next;
    panel.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    btn.querySelector('svg').outerHTML = open ? ICON_CLOSE : ICON_CHAT;
    if (open) {
      setUnread(0);
      showGreeting();
      ensureSession().then(poll);
      if (!pollTimer) pollTimer = setInterval(poll, 4000);
      setTimeout(function () { inputEl && inputEl.focus(); }, 60);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---------- boot ----------
  function boot() {
    injectStyles(cfg.color || DEFAULT_COLOR);
    buildPanel();
    whenBodyReady(function () {
      document.body.appendChild(btn);
      document.body.appendChild(panel);
    });
    btn.addEventListener('click', function () { toggle(); });
  }

  // Fetch branding first so colours/title match the business; fall back to
  // defaults if the config call fails so the widget always renders.
  api('/config', {})
    .then(function (json) {
      if (json && json.success) {
        var d = json.data;
        cfg.color = cfg.color || d.color || DEFAULT_COLOR;
        cfg.title = cfg.title || d.title;
        cfg.greeting = cfg.greeting || d.greeting;
        cfg.businessName = d.businessName || '';
        cfg.logoUrl = d.logoUrl || '';
        cfg.appointments = !!d.appointmentsEnabled;
        cfg.showPoweredBy = d.showPoweredBy !== false;
        cfg.poweredBy = d.poweredBy || cfg.poweredBy;
      }
    })
    .catch(function () { /* use defaults */ })
    .then(boot);
})();
