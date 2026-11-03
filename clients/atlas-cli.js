#!/usr/bin/env node
/* atlas-cli.js (doc 47 P1): Node CLI for the Exp7 multi-writer atlas log, sharing clients/exp7-sync-core.js with client.html.
 * Commands:  status | read [path-prefix] | watch [--every s] | propose '<ops json>' | flush
 * Options:   --api URL (default https://api.github.com)  --repo owner/name (own; default <login>/atlas-sync-log)
 *            --peers a/r,b/r   --state DIR (outbox + journal; default $TMPDIR/atlas-cli-<login>)
 * Token: env ATLAS_TOKEN only (never a flag, never written to disk). Without a token: read-only, anonymous.
 * Writes go ONLY to the own repo as log/<writer>/<seq>.bin (binary atlas/1, the primary format) via the Contents API (same as the page);
 * --codec json writes .json (debug/interchange). Codec: the copy embedded in client.html, else clients/atlas_codec.bundle.js; if it cannot be loaded
 * or an encode fails, that write falls back to .json with a warning on stderr (a write never fails or drops ops because of the codec).
 * The outbox is written before each PUT and cleared after 201, so a crash re-sends with the same seq (idempotent: 422 + same
 * content = already written). Readers accept .json and .bin. */
'use strict';
const X7 = require('./exp7-sync-core.js'), fs = require('fs'), path = require('path'), os = require('os');
const SEED = (() => { const h = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8'); const m = h.match(/const SEED = (\{[\s\S]*?\n\});/);
  return Function('return ' + m[1])(); })();   // single source of truth for the demo seed: client.html
function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); o[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; } else o._.push(a); } return o; }
const O = args(process.argv.slice(2)), API = (O.api || 'https://api.github.com').replace(/\/$/, ''), TOKEN = process.env.ATLAS_TOKEN || null;
function loadCodec() { try { const h = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8'), a = h.indexOf('/* ATLAS-CODEC-BEGIN'), z = h.indexOf('/* ATLAS-CODEC-END */');
    let src = a < 0 || z < 0 ? '' : h.slice(h.indexOf('*/', a) + 2, z).replace(/<\\\/script/gi, '</script').trim();
    const bp = path.join(__dirname, 'atlas_codec.bundle.js'); if (!src && fs.existsSync(bp)) src = fs.readFileSync(bp, 'utf8');   // not embedded (public repo): local bundle
    if (!src) throw new Error('no codec embedded in client.html and no clients/atlas_codec.bundle.js'); const w = {}; new Function('window', src)(w); X7.setBinaryCodec(w.AtlasCodec.create(w.ATLAS_CODEC_WASM)); return true; }
  catch (e) { process.stderr.write('warning: binary codec unavailable (' + e.message + '); writes fall back to JSON\n'); return false; } }
if (process.env.ATLAS_NO_CODEC !== '1') loadCodec();   // ATLAS_NO_CODEC=1: test hook simulating a codec load failure
X7.setCodecMode(O.codec === 'json' ? 'json' : 'bin');
X7.onCodecFallback(why => process.stderr.write(`warning: ${why}; this segment is written as JSON instead (nothing lost)\n`));
const out = s => process.stdout.write(s + '\n'), die = (s, c = 2) => { process.stderr.write('atlas-cli: ' + s + '\n'); process.exit(c); };
async function gh(method, p, body) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'atlas-cli' };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN; if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(API + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (e) {}
  return { r, j }; }
const b64 = s => Buffer.from(s).toString('base64');
async function readRepo(full, warn) {
  const ref = await gh('GET', `/repos/${full}/git/ref/heads/main`); if (ref.r.status !== 200) { warn(`${full}: no main branch (${ref.r.status})`); return []; }
  const t = await gh('GET', `/repos/${full}/git/trees/${ref.j.object.sha}?recursive=1`), list = [];
  for (const e of (t.j.tree || [])) { if (e.type !== 'blob' || !e.path.startsWith('log/')) continue; const pp = X7.parsePath(e.path.slice(4)); if (!pp) continue;
    const bl = await gh('GET', `/repos/${full}/git/blobs/${e.sha}`); let body;
    try { body = X7.decodeSegment(new Uint8Array(Buffer.from(bl.j.content, 'base64'))); } catch (err) { warn(`${full}/${e.path}: ${err.needCodec ? 'binary segment, codec not loaded in CLI; skipped' : err.message}`); continue; }
    let segs = [body]; if (pp.kind === 'pack') { try { segs = X7.unpack(body, pp.writer, pp.first, pp.last); } catch (err) { warn(`${full}/${e.path}: ${err.message}, skipped`); continue; } }
    for (const sg of segs) { const seq = pp.kind === 'pack' ? +sg.seq : pp.seq; if (!X7.checkSegment(sg, pp.writer, seq)) { warn(`${full}/${e.path}: writer/seq mismatch, skipped`); continue; }
      list.push(X7.entry(full, sg, e.path)); } }
  return list; }
async function who() { if (!TOKEN) return null; const u = await gh('GET', '/user'); if (u.r.status !== 200) die(`token rejected (${u.r.status})`); return u.j.login; }
async function load(login) {
  const own = O.repo || (login ? `${login}/atlas-sync-log` : null), peers = (O.peers ? String(O.peers).split(',') : []).filter(Boolean);
  const repos = [...new Set([own, ...peers].filter(Boolean))]; if (!repos.length) die('nothing to read: give --repo or --peers (or ATLAS_TOKEN)');
  const warns = [], entries = []; for (const r of repos) entries.push(...await readRepo(r, w => warns.push(w)));
  const uniq = new Map(entries.map(e => [X7.keyOf(e.repo, e.seg.writer, e.seg.seq), e]));
  const sorted = [...uniq.values()].sort(X7.cmpOrder), R = X7.replay(sorted, SEED);
  return { own, repos, entries: sorted, S: R.S, events: R.events, warns }; }
function stateDir(login) { const d = O.state || path.join(os.tmpdir(), 'atlas-cli-' + (login || 'reader')); fs.mkdirSync(d, { recursive: true }); return d; }
function journal(d, rec) { fs.appendFileSync(path.join(d, 'journal.ndjson'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n'); }
async function writeBatch(L, login, d, b) {
  for (let tries = 0; tries < 5; tries++) {
    const seg = { v: 2, atlas: 'demo', writer: login, seq: b.seq, ts: b.ts, createdAt: new Date(b.ts).toISOString(), ops: b.ops };
    const body = X7.encodeSegment(seg), p = `log/${login}/${X7.pad(b.seq)}${X7.extOf(body)}`, sz = X7.sizeCheck(Buffer.from(body));
    if (sz.hard) die(`segment ${sz.n} B is over the 1 MB hard limit; split the proposal yourself (never auto-split)`);
    const { r, j } = await gh('PUT', `/repos/${L.own}/contents/${p}`, { message: `atlas:demo writer:${login} seq:${b.seq}`, content: b64(body) });
    if (r.status === 201) { journal(d, { written: p, ops: b.ops.length }); return p; }
    if (r.status === 422) { const ex = L.entries.find(e => e.repo === L.own && e.seg.writer === login && e.seg.seq === b.seq);
      if (ex && JSON.stringify(ex.seg.ops) === JSON.stringify(b.ops)) return p;   // already written by an earlier attempt
      b.seq++; fs.writeFileSync(path.join(d, 'outbox.json'), JSON.stringify(b)); continue; }
    die(`write ${p}: ${r.status} ${j && j.message || ''}`, 3); }
  die('write: too many seq collisions', 3); }
function nextOf(L, login) { let seq = 1, ts = 0; for (const e of L.entries) if (e.repo === L.own && e.seg.writer === login) { seq = Math.max(seq, e.seg.seq + 1); ts = Math.max(ts, +e.seg.ts || 0); } return { seq, ts }; }
async function flush(L, login, d) { const f = path.join(d, 'outbox.json'); if (!fs.existsSync(f)) return null;
  const b = JSON.parse(fs.readFileSync(f, 'utf8')); const p = await writeBatch(L, login, d, b); fs.unlinkSync(f); return p; }
function show(S, prefix) { const o = {}; Object.keys(S.v).sort().forEach(k => { if (!prefix || k.startsWith(prefix)) o[k] = S.v[k]; }); return o; }
(async () => {
  const cmd = O._[0] || 'status', login = await who(); let L = await load(login);
  L.warns.forEach(w => process.stderr.write('warning: ' + w + '\n'));
  if (cmd === 'status') { out(JSON.stringify({ login, own: L.own, repos: L.repos, segments: L.entries.length, writers: [...new Set(L.entries.map(e => e.seg.writer))].sort(),
      changed: L.events.filter(e => e.type === 'changed').length, digest: require('crypto').createHash('sha256').update(X7.stateDigest(L.S)).digest('hex').slice(0, 16) }, null, 1)); return; }
  if (cmd === 'digest') { process.stdout.write(X7.stateDigest(L.S)); return; }
  if (cmd === 'read') { out(JSON.stringify(show(L.S, O._[1]), null, 1)); return; }
  if (cmd === 'watch') { let last = X7.stateDigest(L.S), n = +(O.count || Infinity); out('watching ' + L.repos.join(', '));
    while (n-- > 0) { await new Promise(r => setTimeout(r, 1000 * +(O.every || 15))); L = await load(login); const d = X7.stateDigest(L.S);
      if (d !== last) { const a = JSON.parse(last).v, b = L.S.v; for (const k of Object.keys(b).sort()) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out(`${k} = ${JSON.stringify(b[k])}  (${(L.S.rev[k] || {}).owner || '?'})`); last = d; } } return; }
  if (cmd === 'propose' || cmd === 'flush') {
    if (!login) die('writing needs ATLAS_TOKEN (fine-grained, Contents: Read and write on your own repo)');
    const d = stateDir(login), done = await flush(L, login, d); if (done) { out('flushed outbox: ' + done); L = await load(login); }
    if (cmd === 'flush') return;
    let ops; try { ops = JSON.parse(O._[1]); } catch (e) { die('ops must be JSON: [{"op":"set","path":"joys/i1/value","value":4}]'); }
    if (!Array.isArray(ops) || !ops.length || ops.length > X7.MAX_OPS) die(`1..${X7.MAX_OPS} ops required`);
    const trial = X7.applyBatch(X7.clone(L.S), { writer: login, seq: 0, ops }); const bad = trial.rejected || (trial.results || []).map((x, i) => x && x.status === 'rejected' ? `op ${i}: ${x.reason}` : null).filter(Boolean).join('; ');
    if (bad) die('rejected: ' + bad);
    const nx = nextOf(L, login), b = { seq: nx.seq, ts: Math.max(Date.now(), nx.ts + 1), ops };
    fs.writeFileSync(path.join(d, 'outbox.json'), JSON.stringify(b)); const p = await writeBatch(L, login, d, b); fs.unlinkSync(path.join(d, 'outbox.json'));
    out('wrote ' + L.own + '/' + p); return; }
  die('unknown command ' + cmd + ' (status|read|watch|propose|flush|digest)');
})().catch(e => die(e.stack || String(e), 1));
