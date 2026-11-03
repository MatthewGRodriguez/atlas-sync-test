#!/usr/bin/env node
// Inline clients/exp7-sync-core.js into clients/client.html between the EXP7-CORE markers (keeps client.html one file).
// usage: node tools/inline_core.js [--check]   (--check: exit 1 if client.html is out of date)
'use strict';
const fs = require('fs'), path = require('path');
const H = path.join(__dirname, '../clients/client.html'), J = path.join(__dirname, '../clients/exp7-sync-core.js');
const h = fs.readFileSync(H, 'utf8'), core = fs.readFileSync(J, 'utf8').replace(/<\/script/gi, '<\\/script');
const B = '/* EXP7-CORE-BEGIN', E = '/* EXP7-CORE-END */';
const a = h.indexOf(B), b = h.indexOf(E); if (a < 0 || b < 0) { console.error('markers missing'); process.exit(1); }
const head = h.slice(a, h.indexOf('*/', a) + 2);
const out = h.slice(0, a) + head + '\n' + core + E + h.slice(b + E.length);
if (process.argv.includes('--check')) { const same = out === h; console.log(same ? 'client.html core up to date' : 'client.html core OUT OF DATE'); process.exit(same ? 0 : 1); }
fs.writeFileSync(H, out); console.log('inlined', core.length, 'bytes into', H);
