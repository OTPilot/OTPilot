'use strict';

// API keys shown once on a page (pure: no DOM, no storage). apiKeyOffer.js
// reads the page and asks this module whether a value is a key worth
// offering to save, and how to show it masked.
//
// Two tiers (we prefer a missed offer to a false one):
// 1. A known prefix (sk-proj-, ghp_, sk_live_…) with its length and
//    characters, plus one context signal: copy-once wording, or a Copy
//    control next to it.
// 2. A generic high-entropy token, only with every signal: a key word, the
//    copy-once wording, a Copy control, and a page path that reads like a
//    keys / tokens / settings page.
// AWS: the access key ID (AKIA…) isn't the secret; it's offered only with
// its 40-character secret beside it (clientId + clientSecret).
const ApiKeys = (() => {
  // Most specific first: the first match wins (sk-ant-… before sk-).
  // `min`: the whole value's minimum length; `tail`: the characters after
  // the prefix; `len`: an exact whole length.
  const PREFIXES = [
    { prefix: 'sk-proj-', provider: 'OpenAI', min: 40, tail: /^[A-Za-z0-9_-]+$/ },
    { prefix: 'sk-svcacct-', provider: 'OpenAI', min: 40, tail: /^[A-Za-z0-9_-]+$/ },
    { prefix: 'sk-admin-', provider: 'OpenAI', min: 40, tail: /^[A-Za-z0-9_-]+$/ },
    { prefix: 'sk-or-v1-', provider: 'OpenRouter', min: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'sk-ant-api03-', provider: 'Anthropic', min: 60, tail: /^[A-Za-z0-9_-]+$/ },
    { prefix: 'sk-ant-admin01-', provider: 'Anthropic', min: 60, tail: /^[A-Za-z0-9_-]+$/ },
    // Bare sk-: only long ones (legacy OpenAI and the like).
    { prefix: 'sk-', provider: '', min: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'sk_live_', provider: 'Stripe', min: 30, tail: /^[A-Za-z0-9]+$/, environment: 'live' },
    { prefix: 'sk_test_', provider: 'Stripe', min: 30, tail: /^[A-Za-z0-9]+$/, environment: 'test' },
    { prefix: 'rk_live_', provider: 'Stripe', min: 30, tail: /^[A-Za-z0-9]+$/, environment: 'live' },
    { prefix: 'rk_test_', provider: 'Stripe', min: 30, tail: /^[A-Za-z0-9]+$/, environment: 'test' },
    { prefix: 'whsec_', provider: 'Stripe', min: 30, tail: /^[A-Za-z0-9+/=]+$/ },
    { prefix: 'github_pat_', provider: 'GitHub', min: 60, tail: /^[A-Za-z0-9_]+$/ },
    { prefix: 'ghp_', provider: 'GitHub', len: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'glpat-', provider: 'GitLab', min: 26, tail: /^[A-Za-z0-9_-]+$/ },
    { prefix: 'xoxb-', provider: 'Slack', min: 30, tail: /^[A-Za-z0-9-]+$/ },
    { prefix: 'xoxp-', provider: 'Slack', min: 30, tail: /^[A-Za-z0-9-]+$/ },
    { prefix: 'xapp-', provider: 'Slack', min: 30, tail: /^[A-Za-z0-9-]+$/ },
    { prefix: 're_', provider: 'Resend', min: 30, tail: /^[A-Za-z0-9_]+$/ },
    { prefix: 'SG.', provider: 'SendGrid', min: 60, tail: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
    { prefix: 'hf_', provider: 'Hugging Face', min: 30, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'gsk_', provider: 'Groq', min: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'r8_', provider: 'Replicate', min: 30, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'npm_', provider: 'npm', min: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'pypi-', provider: 'PyPI', min: 60, tail: /^[A-Za-z0-9_-]+$/ },
    { prefix: 'dop_v1_', provider: 'DigitalOcean', min: 70, tail: /^[a-f0-9]+$/ },
    { prefix: 'sbp_', provider: 'Supabase', min: 40, tail: /^[a-f0-9]+$/ },
    { prefix: 'lin_api_', provider: 'Linear', min: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'ntn_', provider: 'Notion', min: 40, tail: /^[A-Za-z0-9]+$/ },
    { prefix: 'shpat_', provider: 'Shopify', min: 38, tail: /^[a-fA-F0-9]+$/ },
    { prefix: 'sntrys_', provider: 'Sentry', min: 60, tail: /^[A-Za-z0-9_+/=]+$/ },
    { prefix: 'AIza', provider: 'Google', len: 39, tail: /^[A-Za-z0-9_-]+$/ },
  ];

  const MAX_LENGTH = 1024;
  const AWS_KEY_ID = /^AKIA[0-9A-Z]{16}$/;
  const AWS_SECRET = /^[A-Za-z0-9/+]{40}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX = /^[0-9a-f]+$/i;
  const GENERIC = /^[A-Za-z0-9_.-]{24,256}$/;
  // Shown but hidden (a key list: "sk-…a9F2", "••••", "****", "xxxx").
  const MASKED = /[…•●*]|\.{3}|x{4,}|X{4,}/;
  // Documentation samples and placeholders.
  const PLACEHOLDER = /your|example|sample|dummy|placeholder|redacted|insert|replace|changeme/i;
  // Not secrets (Stripe / Clerk publishable keys): never offered.
  const PUBLIC = /^pk_(?:live|test)_/;

  // Page wording near the key.
  const KEY_WORDS = /api[\s_-]?keys?|access[\s_-]?keys?|secret[\s_-]?keys?|token|secret/i;
  const COPY_ONCE = /only (?:be )?(?:shown|displayed) once|won['’]t be able to (?:see|view)|will not be able to (?:see|view)|(?:will not|won['’]t) be (?:shown|displayed) again|copy (?:it|this)(?: \w+)? now|make sure to copy|store (?:it|this) (?:somewhere )?safe|this is the only time/i;
  const COPY_CONTROL = /\bcopy\b/i;
  // The generic tier also needs a page path like a keys / settings page: a
  // whole segment (delimited like content.js's PATH_RE), never a substring.
  const PATH_RE = /(?:^|[/\-_.=?&#])(?:api|keys?|tokens?|credentials?|developers?|secrets?|access|integrations?|apps|oauth|settings)(?=[/\-_.=?&#]|$)/;

  // Shannon entropy, bits per character.
  function entropy(s) {
    if (!s) return 0;
    const counts = new Map();
    for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
    let bits = 0;
    for (const n of counts.values()) { const p = n / s.length; bits -= p * Math.log2(p); }
    return bits;
  }

  function classes(s) {
    return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(s)).length;
  }

  const isMasked = value => MASKED.test(String(value || ''));

  const plausible = v => typeof v === 'string' && v.length <= MAX_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(v)
    && !isMasked(v) && !PLACEHOLDER.test(v);

  // The known-prefix entry a value matches, or null. Its random part must
  // look random too (not "sk_test_aaaaaaaa…").
  function known(value) {
    if (!plausible(value)) return null;
    for (const p of PREFIXES) {
      if (!value.startsWith(p.prefix)) continue;
      const tail = value.slice(p.prefix.length);
      const ok = (p.len ? value.length === p.len : value.length >= p.min) && p.tail.test(tail)
        && classes(tail) >= 2 && entropy(tail) >= 3;
      return ok ? p : null;
    }
    return null;
  }

  // A high-entropy token without a known prefix.
  function generic(value) {
    if (!plausible(value) || !GENERIC.test(value) || PUBLIC.test(value) || known(value)) return false;
    if (UUID.test(value) || HEX.test(value)) return false;
    // Letters + punctuation alone is a slug ("my-project-name"): digits or
    // mixed case are needed.
    if (classes(value) < 2 || !(/[0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))) return false;
    // A host name or a dotted version.
    if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) && /\.[A-Za-z]{2,6}$/.test(value)) return false;
    return entropy(value) >= (value.length >= 32 ? 4 : 3.5);
  }

  const isAwsKeyId = value => plausible(value) && AWS_KEY_ID.test(value);
  const isAwsSecret = value => plausible(value) && AWS_SECRET.test(value)
    && classes(value) >= 3 && entropy(value) >= 4 && !isAwsKeyId(value);

  // `context`: { keyWord, copyOnce, copyControl, path } from around the value.
  // → { tier, provider, prefix, environment } or null (no offer).
  function decide(value, context = {}) {
    const k = known(value);
    if (k) {
      if (!context.copyOnce && !context.copyControl) return null;
      return { tier: 1, provider: k.provider, prefix: k.prefix, environment: k.environment || '' };
    }
    if (generic(value) && context.keyWord && context.copyOnce && context.copyControl && pathAllowed(context.path)) {
      return { tier: 2, provider: '', prefix: '', environment: '' };
    }
    return null;
  }

  function pathAllowed(path) {
    return PATH_RE.test(String(path || '').toLowerCase());
  }

  // 'live' / 'test' from the key's prefix (Stripe and Clerk style), else ''.
  function environment(value) {
    const k = known(value);
    if (k?.environment) return k.environment;
    if (/^[a-z]{2}_live_/.test(value || '')) return 'live';
    if (/^[a-z]{2}_test_/.test(value || '')) return 'test';
    return '';
  }

  // The key as the offer shows it: its known prefix, dots, its last 4.
  function mask(value) {
    const v = String(value || '');
    const prefix = known(v)?.prefix || '';
    return `${prefix}••••••••${v.length > prefix.length + 8 ? v.slice(-4) : ''}`;
  }

  // A short in-memory id for a value (remembering a dismissed offer without
  // keeping the key). Not a cryptographic hash: never stored nor sent.
  function fingerprint(value) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  return {
    PREFIXES, KEY_WORDS, COPY_ONCE, COPY_CONTROL,
    known, generic, decide, pathAllowed, environment, mask, isMasked, entropy, fingerprint,
    isAwsKeyId, isAwsSecret,
  };
})();
