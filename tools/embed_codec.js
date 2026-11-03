#!/usr/bin/env node
// Embed the Artist's binary atlas/1 codec (atlas_browser.js glue + wasm base64, built by tools/build_codec_bundle.sh) into
// clients/client.html between the ATLAS-CODEC markers, so the single-file page writes binary by default with no server.
// usage: node tools/embed_codec.js [bundle.js (default clients/atlas_codec.bundle.js)] [--check]   (--check: exit 1 if out of date)
//        node tools/embed_codec.js --strip   (empty the markers: the form committed to the PUBLIC repo, since the codec is the Artist's code;
//        the page then loads atlas_codec.bundle.js next to it, and falls back to JSON writes with a warning if that is missing)
// Node helper: require('./embed_codec.js').extract(htmlText) -> the embedded bundle source (used by atlas-cli.js and the tests).
'use strict';
const fs = require('fs'), path = require('path');
const B = '/* ATLAS-CODEC-BEGIN', E = '/* ATLAS-CODEC-END */';
function extract(h) { const a = h.indexOf(B), b = h.indexOf(E); if (a < 0 || b < 0) return ''; return h.slice(h.indexOf('*/', a) + 2, b).replace(/<\\\/script/gi, '</script').trim(); }
module.exports = { extract };
if (require.main === module) {
  const H = path.join(__dirname, '../clients/client.html'), args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const J = args[0] || path.join(__dirname, '../clients/atlas_codec.bundle.js');
  const h = fs.readFileSync(H, 'utf8'), a = h.indexOf(B), b = h.indexOf(E); if (a < 0 || b < 0) { console.error('markers missing'); process.exit(1); }
  const code = process.argv.includes('--strip') ? '' : fs.readFileSync(J, 'utf8').replace(/<\/script/gi, '<\\/script');
  const out = h.slice(0, a) + h.slice(a, h.indexOf('*/', a) + 2) + '\n' + (code ? code.trim() + '\n' : '') + h.slice(b);
  if (process.argv.includes('--check')) { const same = out === h; console.log(same ? 'client.html codec up to date' : 'client.html codec OUT OF DATE'); process.exit(same ? 0 : 1); }
  fs.writeFileSync(H, out); console.log(code ? 'embedded' : 'stripped', code.length, 'bytes; client.html is now', Buffer.byteLength(out), 'bytes');
}
