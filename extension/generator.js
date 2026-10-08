'use strict';

// Password and PIN generator for 2.0 — pure, no storage. Uses
// crypto.getRandomValues with rejection sampling, so every character of the
// pool is equally likely (no modulo bias).
const Generator = (() => {
  const SETS = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digits: '0123456789',
    symbols: '!#$%&*+-=?@^_~',
  };
  // Easy to misread: 0/O/o, 1/l/I, and the pipe-like characters.
  const AMBIGUOUS = new Set('0Oo1lI|');

  const DEFAULTS = { mode: 'password', length: 16, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true };
  const LIMITS = { password: [8, 64], pin: [4, 12] };

  // Uniform integer in [0, n).
  function randomIndex(n) {
    const max = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0] < max) return buf[0] % n;
    }
  }

  const pick = chars => chars[randomIndex(chars.length)];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function normalize(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const [min, max] = LIMITS[o.mode] || LIMITS.password;
    o.length = Math.min(max, Math.max(min, Math.round(Number(o.length) || DEFAULTS.length)));
    if (o.mode === 'password' && !o.upper && !o.lower && !o.digits && !o.symbols) o.lower = true;
    return o;
  }

  function pools(o) {
    if (o.mode === 'pin') return [SETS.digits];
    const strip = s => (o.avoidAmbiguous ? [...s].filter(c => !AMBIGUOUS.has(c)).join('') : s);
    return ['upper', 'lower', 'digits', 'symbols'].filter(k => o[k]).map(k => strip(SETS[k]));
  }

  // At least one character from every enabled set, the rest from all of them,
  // then shuffled so the guaranteed ones aren't always first.
  function generate(opts) {
    const o = normalize(opts);
    const sets = pools(o);
    const all = sets.join('');
    const chars = sets.map(pick);
    while (chars.length < o.length) chars.push(pick(all));
    return shuffle(chars).join('');
  }

  // Entropy of the generator's output in bits (what an attacker who knows the
  // settings faces), and a label for it.
  function strength(opts) {
    const o = normalize(opts);
    const bits = Math.round(o.length * Math.log2(pools(o).join('').length));
    const label = bits >= 100 ? 'Very strong' : bits >= 70 ? 'Strong' : bits >= 45 ? 'Fair' : 'Weak';
    return { bits, label };
  }

  return { DEFAULTS, LIMITS, generate, strength, normalize };
})();
