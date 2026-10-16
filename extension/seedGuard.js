'use strict';

// Phishing guard for crypto wallets: no real website, support agent or
// airdrop ever asks for a wallet's recovery phrase, yet that's how most wallets
// are drained. When a page's field gets one (12–24 words, all from the BIP39
// list: bip39.js), typed or pasted into one field or spread over a grid of
// one-word boxes, OTPilot warns before it's submitted. Everything happens
// here: nothing is stored or sent, not even to the background.
//
// Loaded after content.js (themeUi). "It's my wallet" stops the warnings on
// that site (`seedGuardAllow:<host>` in chrome.storage.local).
(() => {
  if (window.top !== window || typeof Bip39 === 'undefined') return;

  const BANNER_ID = 'otpilot-seed-guard';
  const host = location.hostname;
  let allowed = null;   // null until read
  let dismissed = false; // "I understand" holds for this page
  let timer = null;

  const allowKey = `seedGuardAllow:${host}`;
  function readAllowed() {
    if (allowed !== null) return Promise.resolve(allowed);
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(allowKey, r => {
          allowed = !chrome.runtime.lastError && !!r?.[allowKey];
          resolve(allowed);
        });
      } catch { allowed = false; resolve(false); }
    });
  }

  const TEXT_TYPES = ['text', 'password', 'search', 'email', ''];
  const isField = el => el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement && TEXT_TYPES.includes((el.getAttribute('type') || '').toLowerCase()));

  // The fields that hold the phrase, or [] when none does: the edited field
  // on its own, or the one-word fields of its form (the page when it has none).
  function phraseFields(target) {
    if (Bip39.looksLikePhrase(Bip39.words(target.value))) return [target];
    const one = el => {
      const w = String(el.value || '').trim().toLowerCase();
      return /^[a-z]+$/.test(w) && Bip39.isWord(w);
    };
    if (!one(target)) return [];
    const scope = target.form || document;
    const boxes = [...scope.querySelectorAll('input, textarea')].filter(el => isField(el) && one(el));
    return boxes.length >= Bip39.COUNTS[0] ? boxes : [];
  }

  function check(target) {
    if (!chrome.runtime?.id) return; // extension reloaded: this script is orphaned
    if (dismissed || document.getElementById(BANNER_ID) || !target?.isConnected) return;
    const fields = phraseFields(target);
    if (!fields.length) return;
    readAllowed().then(ok => { if (!ok && !dismissed) showBanner(fields); });
  }

  function onEdit(e) {
    const target = e.target;
    if (!isField(target)) return;
    clearTimeout(timer);
    timer = setTimeout(() => check(target), e.type === 'paste' ? 50 : 400);
  }

  function showBanner(fields) {
    const el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', 'OTPilot: recovery phrase warning');
    Object.assign(el.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647',
      width: 'min(440px, calc(100vw - 32px))', boxSizing: 'border-box',
      padding: '14px 16px', borderRadius: '10px',
      background: 'var(--surface, #1e293b)',
      border: '1px solid var(--danger, #f87171)',
      borderLeft: '4px solid var(--danger, #f87171)',
      boxShadow: '0 8px 30px rgba(0,0,0,.45)',
      fontFamily: 'var(--font-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
      fontSize: '13px', lineHeight: '1.45', color: 'var(--ink-1, #e2e8f0)', textAlign: 'left',
    });

    const title = document.createElement('div');
    title.textContent = 'This looks like a crypto wallet recovery phrase';
    Object.assign(title.style, { fontWeight: '700', fontSize: '14px', color: 'var(--ink-0, #f1f5f9)', marginBottom: '4px' });

    const text = document.createElement('div');
    text.textContent = 'No real website, support agent or airdrop asks for it. Anyone who gets these words can take everything in the wallet. Only type them into your wallet app.';
    Object.assign(text.style, { color: 'var(--ink-3, #94a3b8)', marginBottom: '10px' });

    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
    const button = (label, primary, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, {
        padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontSize: '12px', fontWeight: '600',
        border: primary ? 'none' : '1px solid var(--border, #334155)',
        background: primary ? 'var(--danger, #f87171)' : 'transparent',
        color: primary ? 'var(--on-accent, #ffffff)' : 'var(--ink-2, #cbd5e1)',
      });
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(); });
      actions.appendChild(b);
      return b;
    };
    const close = () => el.remove();
    button('Clear it', true, () => {
      const setter = (proto => Object.getOwnPropertyDescriptor(proto, 'value')?.set);
      for (const f of fields) {
        if (!f.isConnected) continue;
        const set = setter(f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
        if (set) set.call(f, ''); else f.value = '';
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
    });
    button('I understand', false, () => { dismissed = true; close(); });
    button(`It's my wallet (${host})`, false, () => {
      allowed = true;
      try { chrome.storage.local.set({ [allowKey]: true }); } catch { /* extension reloaded */ }
      close();
    });

    el.append(title, text, actions);
    // Clicks inside stay ours (the page's outside-click handlers never see them).
    for (const type of ['mousedown', 'pointerdown', 'click']) el.addEventListener(type, e => e.stopPropagation());
    themeUi(el);
    (document.body || document.documentElement).appendChild(el);
  }

  document.addEventListener('input', onEdit, true);
  document.addEventListener('paste', onEdit, true);
})();
