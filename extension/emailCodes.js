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

  // An HTML page (Gmail's print view of a message) as plain text.
  function htmlText(html) {
    return decodeEntities(String(html || '')
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
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

  // A host's name without subdomains or public suffix, roughly: online.bbva.com.ar
  // → bbva, bbva.es → bbva, mail.notion.so → notion. Good enough to tell whether
  // an email comes from the site being signed in to; not a security boundary on
  // its own (see fromSite).
  const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'gob', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'nom']);
  function siteName(host) {
    const labels = String(host || '').toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
    if (labels.length < 2) return labels[0] || '';
    labels.pop();
    if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
    return labels[labels.length - 1];
  }

  // Whether an email is from the site at `pageHost`: the sender's domain has the
  // same name, or the name is a word of the sender's name / subject / snippet
  // ("Tu código de belo"). A page on another site never gets the code, so a page
  // can't show a code field and collect the code another site just emailed.
  function fromSite(entry, pageHost) {
    const name = siteName(pageHost);
    if (name.length < 2) return false;
    const senderHost = (entry.authorEmail || '').split('@')[1] || '';
    if (senderHost && siteName(senderHost) === name) return true;
    const words = `${entry.author || ''} ${entry.title || ''} ${entry.summary || ''}`.toLowerCase();
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'u').test(words);
  }

  return { CODE_RE, OTP_KEYWORDS, pickBestCode, decodeEntities, htmlText, parseFeed, siteName, fromSite };
})();
