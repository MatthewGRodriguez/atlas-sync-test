#!/usr/bin/env node
// Unit tests for clients/exp7-sync-core.js (Node built-ins only, no network, no files written). SYNTHETIC data.
// usage: node tools/core_test.js [--codec clients/atlas_codec.bundle.js]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), X = require('../clients/exp7-sync-core.js');
let n = 0, bad = 0; const ok = (c, name, info) => { n++; if (!c) bad++; console.log((c ? 'PASS ' : 'FAIL ') + name + (c || info === undefined ? '' : '  ' + JSON.stringify(info))); };
const SEED = { 'joys/i1/value': 3, 'joys/i3/value': 4, 'items/i1/notes': [] };
const seg = (writer, seq, ts, ops) => ({ v: 2, atlas: 'demo', writer, seq, ts, ops });
const E = (repo, s) => X.entry(repo, s, `log/${s.writer}/${X.pad(s.seq)}.json`);
// ordering + LWW + conflict reports
{ const a = seg('alice', 1, 1000, [{ op: 'set', path: 'joys/i3/value', value: 7 }]), b = seg('bob', 1, 1000, [{ op: 'set', path: 'joys/i3/value', value: 9 }]);
  const r1 = X.replay([E('alice/r', a), E('bob/r', b)], SEED), r2 = X.replay([E('bob/r', b), E('alice/r', a)], SEED);
  ok(r1.S.v['joys/i3/value'] === 9 && r1.S.rev['joys/i3/value'].owner === 'bob', 'same ts: tie broken by writer id (bob > alice) -> bob wins');
  ok(X.stateDigest(r1.S) === X.stateDigest(r2.S), 'input order does not matter (deterministic merge order)');
  const ov = r1.events.filter(e => e.type === 'overwrote'), ch = r1.outcomes.find(o => o.key === 'bob/r:bob:1').changed;
  ok(ov.length === 1 && ov[0].to === 'alice' && ov[0].yours === 'alice:1' && ov[0].theirs === 'bob:1', 'overwrote event addressed to alice (yours alice:1, theirs bob:1)', ov);
  ok(ch.length === 1 && ch[0].path === 'joys/i3/value' && ch[0].from === 'alice', "bob's outcome changed:[{path, from:'alice'}] (rule 16)", ch);
  const c2 = seg('alice', 2, 999, [{ op: 'set', path: 'joys/i3/value', value: 1 }]);
  const r3 = X.replay([E('alice/r', a), E('bob/r', b), E('alice/r', c2)], SEED);
  ok(r3.S.v['joys/i3/value'] === 9, 'late segment with an older ts slots in before (LWW by order, not arrival)'); }
// deltas add, no-op add keeps revision, exists rejection, batch limit
{ const r = X.replay([E('a/r', seg('a', 1, 1, [{ op: 'delta', path: 'joys/i1/value', by: 2 }])), E('b/r', seg('b', 1, 2, [{ op: 'delta', path: 'joys/i1/value', by: 3 }, { op: 'add', path: 'joys/i1/value', value: 1 }, { op: 'add', path: 'items/i1/notes', value: 'x' }])),
    E('a/r', seg('a', 2, 3, [{ op: 'add', path: 'items/i1/notes', value: 'x' }]))], SEED);
  ok(r.S.v['joys/i1/value'] === 8, 'concurrent deltas add up'); ok(r.outcomes[1].results[1].reason === 'exists', 'add on existing scalar rejected (exists)');
  ok(r.S.rev['items/i1/notes'].rev === 1 && r.outcomes[2].results[0].status === 'noop', 'no-op add leaves revision unchanged');
  const big = X.applyBatch({ v: {}, rev: {} }, seg('a', 3, 4, Array.from({ length: 5001 }, () => ({ op: 'set', path: 'p', value: 1 }))));
  const ok5k = X.applyBatch({ v: {}, rev: {} }, seg('a', 3, 4, Array.from({ length: 5000 }, (_, i) => ({ op: 'set', path: 'p' + i, value: i }))));
  ok(big.rejected === 'batch too large' && ok5k.results.length === 5000 && !ok5k.rejected, '5000 ops ok, 5001 rejected'); }
// packs: soft 256 KB, hard 1 MB, contiguous, never split
{ const mk = (seq, bytes) => seg('alice', seq, seq, [{ op: 'set', path: 'items/i1/name', value: 'x'.repeat(bytes) }]);
  const segs = []; for (let i = 1; i <= 40; i++) segs.push(mk(i, 20000));
  const g = X.planPacks(segs); const sizes = g.map(x => X.encodePack(X.packBody('alice', x)).length);
  ok(g.length >= 3 && sizes.every(s => s <= X.SEG_SOFT), '40 x 20 KB segments -> packs each <= 256 KB', sizes);
  ok(g.flat().length >= 39 && new Set(g.flat().map(s => s.seq)).size === g.flat().length && g.every(x => x.every((s, i) => i === 0 || s.seq === x[i - 1].seq + 1)), 'each segment in at most one pack (a trailing single may stay), contiguous seqs', g.map(x => x.length));
  const huge = [mk(1, 10), mk(2, 1100000), mk(3, 10), mk(4, 10)]; const gh = X.planPacks(huge);
  ok(!gh.flat().some(s => s.seq === 2) && gh.length === 1 && gh[0][0].seq === 3, 'a >1 MB segment is never packed or split; packs do not span it', gh.map(x => x.map(s => s.seq)));
  const gap = X.planPacks([mk(1, 10), mk(2, 10), mk(5, 10), mk(6, 10)]); ok(gap.length === 2, 'packs never span a seq gap');
  ok(X.planPacks([mk(1, 10)]).length === 0, 'one segment: nothing to pack (no change)');
  const body = X.packBody('alice', segs.slice(0, 3)), back = X.unpack(JSON.parse(new TextDecoder().decode(X.encodePack(body))), 'alice', 1, 3);
  ok(JSON.stringify(back) === JSON.stringify(segs.slice(0, 3)), 'pack round-trip = the same segments');
  let thrown = 0; try { X.unpack(body, 'bob', 1, 3); } catch { thrown++; } try { X.unpack(body, 'alice', 1, 4); } catch { thrown++; } ok(thrown === 2, 'pack with wrong writer/range is refused');
  const r1 = X.replay(segs.map(s => E('alice/r', s)), SEED), r2 = X.replay(back.concat(segs.slice(3)).map(s => X.entry('alice/r', s, 'log/alice/pack-000001-000003.json')), SEED);
  ok(X.stateDigest(r1.S) === X.stateDigest(r2.S), 'replay with pack = replay with singles'); }
// snapshots: cache only
{ const all = []; for (let i = 1; i <= 30; i++) all.push(E(i % 2 ? 'alice/r' : 'bob/r', seg(i % 2 ? 'alice' : 'bob', Math.ceil(i / 2), 1000 + i, [{ op: 'delta', path: 'joys/i1/value', by: 1 }, { op: 'set', path: 'joys/i3/value', value: i }])));
  const snap = X.makeSnapshot(all.slice(0, 20), SEED), later = all.slice(20), full = X.replay(all, SEED);
  const from = X.useSnapshot(JSON.parse(JSON.stringify(snap)), later); const part = X.replay(later, SEED, { from });
  ok(from && X.stateDigest(part.S) === X.stateDigest(full.S), 'snapshot + remaining segments = full replay');
  const late = E('carol/r', seg('carol', 1, 1005, [{ op: 'set', path: 'joys/i3/value', value: 99 }]));
  ok(X.useSnapshot(snap, later.concat([late])) === null, 'a late segment sorting inside the snapshot invalidates it (rebuild)');
  ok(X.useSnapshot({ snapshot: 2 }, later) === null, 'unknown snapshot version is not trusted'); }
// binary codec (opt-in)
{ const bp = (process.argv.indexOf('--codec') > 0 && process.argv[process.argv.indexOf('--codec') + 1]) || path.join(__dirname, '../clients/atlas_codec.bundle.js');
  if (!fs.existsSync(bp)) console.log('SKIP binary codec checks (no ' + bp + '; build with tools/build_codec_bundle.sh)');
  else { const ctx = { window: {}, TextEncoder, TextDecoder, WebAssembly, btoa, atob, Uint8Array, console }; vm.createContext(ctx); vm.runInContext(fs.readFileSync(bp, 'utf8'), ctx);
    const codec = ctx.window.AtlasCodec.create(ctx.window.ATLAS_CODEC_WASM); X.setBinaryCodec(codec); X.setCodecMode('bin');
    const s = seg('alice', 7, 123, [{ op: 'set', path: 'joys/i3/value', value: 4 }, { op: 'add', path: 'items/i1/notes', value: 'é ✓ "q"' }]);
    const b = X.encodeSegment(s); ok(X.isBinary(b) && X.segmentExt() === '.bin', 'binary mode writes a JRB container, .bin', b.length);
    ok(JSON.stringify(X.decodeSegment(b)) === JSON.stringify(s), 'binary segment round-trips to the same JSON');
    const many = seg('alice', 8, 124, Array.from({ length: 5000 }, (_, i) => ({ op: 'set', path: 'items/i' + (i % 50) + '/values/v' + i, value: i })));
    const bj = new TextEncoder().encode(JSON.stringify(many, null, 1)).length, bb = X.encodeSegment(many).length; console.log('     5000-op segment: JSON ' + bj + ' B, atlas/1 ' + bb + ' B');
    ok(JSON.stringify(X.decodeSegment(X.encodeSegment(many))) === JSON.stringify(many) && bb < X.SEG_SOFT, '5000-op segment round-trips, under 256 KB in atlas/1', { bj, bb });
    X.setCodecMode('json'); ok(JSON.stringify(X.decodeSegment(b)) === JSON.stringify(s), 'JSON-mode reader still decodes binary segments (magic detect)');
    X.setBinaryCodec(null); let need = false; try { X.decodeSegment(b); } catch (e) { need = !!e.needCodec; } ok(need, 'binary segment without codec -> needCodec error (no guess)'); } }
console.log(`\nRESULT ${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
