'use strict';

// Email one-time codes (pure): picking the code out of an email's text, and
// reading Gmail's Atom feed. Loaded as a content script before email-reader.js
// (webmail tabs) and by the background (importScripts), which reads the feed.

const EmailCodes = (() => {

  const CODE_RE = /\b\d{4,8}\b/g;
  const OTP_KEYWORDS = /(c[oó]digo|code|verificaci[oó]n|verification|passcode|one[- ]?time|2fa|otp|pin|security|seguridad|c[oó]d\.?|auth)/i;

  // Picks the most likely OTP from a block of text.
  // REQUIRES an OTP keyword within ~80 chars of the digits — if no candidate has
  // one, returns null (never invents a code from a random number in the inbox).
  // (~80 because emails often phrase it as "código … que vencerá en 15 minutos.\n123456",
  // pushing the keyword well past a tighter window.)
  // When expectedLength is given (the number of digits the login page asks for),
  // only digit-runs of exactly that length are considered.
  function pickBestCode(text, expectedLength) {
    if (!text) return null;
    const matches = [];
    for (const m of text.matchAll(CODE_RE)) matches.push({ code: m[0], idx: m.index });
    if (!matches.length) return null;

    let best = null, bestScore = -Infinity;
    for (let i = 0; i < matches.length; i++) {
      const { code, idx } = matches[i];
      // Length filter: the page tells us how many digits to expect.
      if (expectedLength && code.length !== expectedLength) continue;
      // Hard gate: a candidate is only valid with an OTP keyword nearby.
      const ctx = text.slice(Math.max(0, idx - 80), idx + code.length + 80);
      if (!OTP_KEYWORDS.test(ctx)) continue;

      let score = 100;
      // 6-digit codes are the most common OTP length (only matters when the
      // expected length is unknown).
      if (code.length === 6) score += 10;
      // A bare 4-digit year is rarely the code.
      if (code.length === 4 && /^(19|20)\d\d$/.test(code)) score -= 50;
      // Tie-break toward earlier matches.
      score -= i;
      if (score > bestScore) { bestScore = score; best = code; }
    }
    return best;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  // An HTML page (Gmail's print view of a message) as plain text. Block
  // elements and cells break the text; inline ones don't, so a code styled
  // digit by digit (<span>604</span><span>281</span>) stays one number.
  const BLOCK_TAG = /<\/?(p|div|br|tr|td|th|li|ul|ol|table|tbody|thead|h[1-6]|blockquote|section|article|header|footer|center|hr)\b[^>]*>/gi;
  function htmlText(html) {
    return decodeEntities(String(html || '')
      .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '\n')
      .replace(BLOCK_TAG, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/[ \t\r\f\v]+/g, ' ');
  }

  // Gmail's Atom feed (/mail/u/N/feed/atom: the unread messages of the inbox)
  // → { account, entries: [{ title, summary, issued (ms), messageId, author, authorEmail }] }.
  // A service worker has no DOMParser; the feed is simple enough for regexes.
  function parseFeed(xml) {
    const tag = (block, name) => {
      const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
    };
    xml = String(xml || '');
    const firstEntry = xml.search(/<entry\b/i);
    const account = tag(firstEntry < 0 ? xml : xml.slice(0, firstEntry), 'title');
    const entries = [];
    for (const [block] of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
      const href = decodeEntities((block.match(/<link\b[^>]*href=["']([^"']+)["']/i) || [])[1] || '');
      const author = (block.match(/<author\b[\s\S]*?<\/author>/i) || [''])[0];
      entries.push({
        title:       tag(block, 'title'),
        summary:     tag(block, 'summary'),
        issued:      Date.parse(tag(block, 'issued') || tag(block, 'modified')) || 0,
        messageId:   (href.match(/[?&]message_id=([0-9a-f]+)/i) || [])[1] || null,
        author:      tag(author, 'name'),
        authorEmail: tag(author, 'email').toLowerCase(),
      });
    }
    return { account, entries };
  }

  // A host's registrable domain, roughly (no Public Suffix List here):
  // online.bbva.com.ar → bbva.com.ar, mail.notion.so → notion.so,
  // accounts.google.com → google.com.
  const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'gob', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'nom']);
  // Hosts where anyone gets a subdomain (the Public Suffix List's private
  // section, its common ones): user.github.io is its own site, never github.io.
  const SHARED_HOSTING = new Set([
    'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'pages.dev', 'workers.dev',
    'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com',
    'onrender.com', 'fly.dev', 'glitch.me', 'repl.co', 'replit.app', 'surge.sh', 'wordpress.com',
    'myshopify.com', 'wixsite.com', 'squarespace.com', 'webflow.io', 'framer.app', 'ngrok.io', 'ngrok-free.app',
    'amplifyapp.com', 'azurestaticapps.net', 'cloudflareaccess.com', 's3.amazonaws.com', 'deno.dev', 'railway.app',
    'up.railway.app', 'supabase.co', 'notion.site', 'carrd.co', 'neocities.org', 'bitbucket.io', 'readthedocs.io',
  ]);
  function registrableDomain(host) {
    const labels = String(host || '').toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
    const n = labels.length;
    let keep = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2]) ? 3 : 2;
    // Longest shared-hosting suffix → one more label (the tenant).
    for (let k = Math.min(n - 1, 3); k >= 2; k--) {
      if (SHARED_HOSTING.has(labels.slice(-k).join('.'))) { keep = k + 1; break; }
    }
    return labels.slice(-keep).join('.');
  }

  // Whether an email was sent by the site at `pageHost`: the sender's address
  // is on the same registrable domain (security@mail.bbva.es for
  // online.bbva.es). Nothing weaker — not a word of the subject, not the same
  // name under another ending (bbva.xyz) —, so a page can't show a code field
  // and collect the code another site just emailed.
  function fromSite(entry, pageHost) {
    const page = registrableDomain(pageHost);
    const sender = (entry.authorEmail || '').split('@')[1] || '';
    return !!page && !!sender && registrableDomain(sender) === page;
  }

  return { CODE_RE, OTP_KEYWORDS, pickBestCode, decodeEntities, htmlText, parseFeed, registrableDomain, fromSite };
})();
