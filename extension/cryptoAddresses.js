'use strict';

// Crypto wallet addresses (the vault's "Crypto wallet" type): which network an
// address looks like, and its QR code to receive funds. Pure, no storage; the
// QR comes from qrcode.js (kazuhikoarase/qrcode-generator, MIT), loaded first.
//
// Detection is a hint for the editor's network picker, never a check: the
// user can always pick another network (an EVM address is the same on
// Ethereum, Base, Polygon…, so it's offered as "Ethereum / EVM").
const CryptoAddresses = (() => {
  const NETWORKS = ['Bitcoin', 'Ethereum / EVM', 'Solana', 'Tron', 'Litecoin', 'Dogecoin', 'Cosmos', 'Other'];

  const B58 = '[1-9A-HJ-NP-Za-km-z]';
  const BECH32 = '[02-9ac-hj-np-z]';
  // In order: the first that matches wins (base58 formats overlap, so the
  // ones with a fixed prefix go before Solana's bare base58).
  const PATTERNS = [
    ['Ethereum / EVM', new RegExp('^0x[0-9a-fA-F]{40}$')],
    ['Bitcoin', new RegExp(`^(bc1${BECH32}{11,71}|[13]${B58}{25,34})$`)],
    ['Litecoin', new RegExp(`^(ltc1${BECH32}{11,71}|[LM]${B58}{26,33})$`)],
    ['Tron', new RegExp(`^T${B58}{33}$`)],
    ['Dogecoin', new RegExp(`^D[5-9A-HJ-NP-U]${B58}{32}$`)],
    ['Cosmos', new RegExp(`^cosmos1${BECH32}{38}$`)],
    ['Solana', new RegExp(`^${B58}{32,44}$`)],
  ];

  // The network an address looks like, or '' when none does.
  function detect(address) {
    const a = String(address || '').trim();
    return PATTERNS.find(([, re]) => re.test(a))?.[0] || '';
  }

  // The address as an SVG QR code (black on white, so wallets' cameras read it
  // in either theme), or '' when qrcode.js isn't loaded or the text is empty.
  function qrSvg(text, size = 160) {
    const value = String(text || '').trim();
    if (!value || typeof qrcode !== 'function') return '';
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const total = n + quiet * 2;
    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  // "0x52908…f3a1": enough to recognize an address in a list.
  function short(address) {
    const a = String(address || '').trim();
    return a.length > 16 ? `${a.slice(0, 7)}…${a.slice(-4)}` : a;
  }

  return { NETWORKS, detect, qrSvg, short };
})();
