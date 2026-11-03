/* exp7-sync-core.js (doc 47 P0): replay, validator, ordering, events, codec hooks, packs, snapshots.
 * No DOM, no network. Same source runs in Node (require) and is inlined into clients/client.html by
 * tools/inline_core.js (between the EXP7-CORE markers). SYNTHETIC data only; never a token. */
(function (root) {
'use strict';
const te = new TextEncoder(), td = new TextDecoder();
const MAX_OPS = 5000, SEG_SOFT = 256 * 1024, SEG_HARD = 1024 * 1024;
const clone = o => JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(6, '0');
let isList = p => /\/notes$/.test(p);
function setListRule(f) { isList = f; }

/* ---------- codec (JSON default; binary atlas/1 opt-in via setBinaryCodec) ---------- */
const MAGIC = [74, 82, 66];   // 'JRB' + 'A' (atlas) | 'W' (world, pre-ADR 0106) + version byte: the Artist codec container header
const C = { mode: 'json', impl: null };
function setBinaryCodec(impl) { C.impl = impl || null; if (!impl) C.mode = 'json'; }
function setCodecMode(m) { if (m === 'bin' && !C.impl) throw new Error('binary codec not loaded'); C.mode = m === 'bin' ? 'bin' : 'json'; }
function codecMode() { return C.mode; }
function isBinary(b) { if (!b || b.length < 5) return false; for (let i = 0; i < 3; i++) if (b[i] !== MAGIC[i]) return false; return (b[3] === 65 || b[3] === 87) && b[4] >= 1 && b[4] < 16; }
function encJSON(o, pretty) { return te.encode(pretty ? JSON.stringify(o, null, 1) : JSON.stringify(o)); }
function encode(o, pretty) { return C.mode === 'bin' ? C.impl.encode(te.encode(JSON.stringify(o))) : encJSON(o, pretty); }
function decode(bytes) {
  if (isBinary(bytes)) { if (!C.impl) { const e = new Error('binary segment but binary codec not loaded'); e.needCodec = true; throw e; } return JSON.parse(td.decode(C.impl.decode(bytes))); }
  return JSON.parse(td.decode(bytes)); }
const encodePack = o => encode(o, false), encodeSegment = seg => encode(seg, true), decodeSegment = decode, encodeSnapshot = s => encode(s, true), decodeSnapshot = decode;
const segmentExt = () => C.mode === 'bin' ? '.bin' : '.json';

/* ---------- op rules (doc 42 §3.7, ADR 0108; same as client.html v2) ---------- */
function applyOp(S, op, writer, seq) {
  const p = op.path; if (typeof p !== 'string' || !p) return { status: 'rejected', reason: 'bad path' };
  const has = Object.prototype.hasOwnProperty.call(S.v, p); const before = has ? clone(S.v[p]) : undefined;
  let after, status = 'applied';
  switch (op.op) {
    case 'set': case 'ref': after = op.op === 'ref' ? op.target ?? op.value : op.value; if (has && JSON.stringify(before) === JSON.stringify(after)) status = 'noop'; break;
    case 'delta': { const by = Number(op.by ?? op.value); if (!isFinite(by)) return { status: 'rejected', reason: 'delta not a number' };
      if (has && typeof before !== 'number') return { status: 'rejected', reason: 'delta on non-number' }; after = (has ? before : 0) + by; if (by === 0) status = 'noop'; break; }
    case 'add':
      if (isList(p)) { const L = has ? before : []; if (L.includes(op.value)) status = 'noop'; else after = L.concat([op.value]); }
      else if (has) return { status: 'rejected', reason: 'exists' }; else after = op.value; break;
    case 'remove':
      if (!has) status = 'noop';
      else if (isList(p) && op.value !== undefined) { if (!before.includes(op.value)) status = 'noop'; else after = before.filter(x => x !== op.value); }
      else after = undefined; break;
    default: return { status: 'rejected', reason: 'unknown op ' + op.op };
  }
  if (status === 'noop') return { status };
  const prev = S.rev[p] || { rev: 0, owner: null };
  if (after === undefined) delete S.v[p]; else S.v[p] = after;
  const res = { status };
  if (has && prev.owner && prev.owner !== writer) res.changed = { path: p, from: before, prevOwner: prev.owner, prevLast: prev.last || null };
  S.rev[p] = { rev: prev.rev + 1, owner: writer, last: writer + ':' + seq };
  return res;
}
function applyBatch(S, seg) {
  const ops = Array.isArray(seg.ops) ? seg.ops : [];
  if (ops.length > MAX_OPS) return { rejected: 'batch too large', results: [] };
  const results = ops.map(o => applyOp(S, o, seg.writer, seg.seq));
  return { results, changed: results.filter(r => r.changed).map(r => r.changed) };
}

/* ---------- ordering: [ts, writer, seq, repo], last write wins ---------- */
function cmpOrder(a, b) { const x = a.order, y = b.order;
  return (x[0] - y[0]) || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || (x[2] - y[2]) || (x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0); }
const segTs = seg => Number.isFinite(+seg.ts) ? +seg.ts : (Date.parse(seg.createdAt) || 0);
const entry = (repo, seg, path) => ({ seg, order: [segTs(seg), seg.writer, +seg.seq, repo], repo, path: path || null });
const keyOf = (repo, writer, seq) => `${repo}:${writer}:${seq}`;

/* replay(entries, seed, {from}) -> {S, outcomes:[{key, changed:[{path, from}]}], events:[...]}
 * events: {type:'changed', path, by, seq, from (value), prevOwner}  - every accepted overwrite of another writer's value
 *         {type:'overwrote', path, yours:'w:seq', theirs:'w:seq', by, to:'owner'} - addressed to prevOwner (doc 47 §4.4)
 * from = {S, covered:Set(keys)} starts from a snapshot state and skips covered entries. */
function replay(entries, seed, o) {
  o = o || {}; const S = o.from ? clone(o.from.S) : { v: clone(seed), rev: {} }, outcomes = [], events = [];
  const list = entries.slice().sort(cmpOrder);
  for (const c of list) {
    const k = keyOf(c.repo, c.seg.writer, c.seg.seq); if (o.from && o.from.covered.has(k)) continue;
    const r = applyBatch(S, c.seg); const ch = [];
    r.results.forEach((res, i) => { if (!res.changed) return; ch.push({ path: res.changed.path, from: res.changed.prevOwner });
      events.push({ type: 'changed', key: k, op: i, path: res.changed.path, by: c.seg.writer, seq: c.seg.seq, from: res.changed.from, prevOwner: res.changed.prevOwner });
      events.push({ type: 'overwrote', key: k, op: i, path: res.changed.path, to: res.changed.prevOwner, yours: res.changed.prevLast, theirs: c.seg.writer + ':' + c.seg.seq, by: c.seg.writer }); });
    outcomes.push({ key: k, results: r.results, changed: ch, rejected: r.rejected || null });
  }
  return { S, outcomes, events };
}
/* canonical state bytes (convergence check): sorted keys */
function stateDigest(S) { const v = {}, r = {}; Object.keys(S.v).sort().forEach(k => v[k] = S.v[k]); Object.keys(S.rev).sort().forEach(k => r[k] = S.rev[k]); return JSON.stringify({ v, rev: r }); }

/* ---------- segment paths, validation, sizes ---------- */
function parsePath(rel) { // rel = path below logRoot/: '<w>/<seq>.<ext>' or '<w>/pack-<first>-<last>.<ext>'
  let m = rel.match(/^([^/]+)\/(\d+)\.\w+$/); if (m) return { kind: 'seg', writer: m[1], seq: +m[2] };
  m = rel.match(/^([^/]+)\/pack-(\d+)-(\d+)\.\w+$/); if (m) return { kind: 'pack', writer: m[1], first: +m[2], last: +m[3] };
  return null; }
function checkSegment(seg, writer, seq) { return !!seg && seg.writer === writer && +seg.seq === seq; }
function sizeCheck(bytes) { const n = bytes.length; return { n, soft: n > SEG_SOFT, hard: n > SEG_HARD }; }

/* ---------- per-writer packs (doc 47 §5.5): own segments only, contiguous, never auto-split ---------- */
/* planPacks(segs sorted by seq, {soft, hard, min}) -> [[seg...],...]: groups of >= min segments; a group closes before it would pass
 * soft bytes; a single segment over soft becomes its own group only if <= hard (never split); groups must be contiguous seqs. */
function packBody(writer, segs) { return { v: 2, pack: 1, writer, first: segs[0].seq, last: segs[segs.length - 1].seq, segments: segs }; }
function planPacks(segs, o) {
  o = o || {}; const soft = o.soft || SEG_SOFT, hard = o.hard || SEG_HARD, min = o.min || 2, out = []; let cur = [];
  const size = g => encodePack(packBody(g[0].writer, g)).length;
  const close = () => { if (cur.length >= min) out.push(cur); cur = []; };
  for (const s of segs) {
    if (cur.length && +s.seq !== +cur[cur.length - 1].seq + 1) close();
    const trial = cur.concat([s]);
    if (cur.length && size(trial) > soft) { close(); cur = [s]; } else cur = trial;
    if (cur.length === 1 && size(cur) > hard) cur = []; // oversize single: left as a single file, never packed
  }
  close(); return out; }
function unpack(body, writer, first, last) {
  if (!body || body.pack !== 1 || body.writer !== writer || body.first !== first || body.last !== last || !Array.isArray(body.segments)) throw new Error('bad pack header');
  body.segments.forEach((s, i) => { if (!checkSegment(s, writer, first + i)) throw new Error('pack segment ' + i + ' does not match ' + writer + ':' + (first + i)); });
  if (body.segments.length !== last - first + 1) throw new Error('pack length mismatch'); return body.segments; }

/* ---------- snapshots (doc 47 §5.5): a cache, never a replacement for the log ---------- */
/* makeSnapshot(entries, seed) -> {v:1, snapshot:1, covered:[keys], frontier:order, S}; valid for a reader iff every entry it knows that
 * sorts at or before the frontier is covered and every covered key is known or unreadable-but-covered. useSnapshot returns {from} or null. */
function makeSnapshot(entries, seed, meta) { const list = entries.slice().sort(cmpOrder); const r = replay(list, seed);
  return Object.assign({ v: 1, snapshot: 1, covered: list.map(c => keyOf(c.repo, c.seg.writer, c.seg.seq)), frontier: list.length ? list[list.length - 1].order : null, S: r.S }, meta || {}); }
function useSnapshot(snap, entries) {
  if (!snap || snap.snapshot !== 1 || !Array.isArray(snap.covered)) return null; const cov = new Set(snap.covered);
  for (const c of entries) { const k = keyOf(c.repo, c.seg.writer, c.seg.seq);
    if (!cov.has(k) && snap.frontier && cmpOrder(c, { order: snap.frontier }) <= 0) return null; } // a late segment sorts inside: rebuild
  return { S: snap.S, covered: cov }; }

const api = { MAX_OPS, SEG_SOFT, SEG_HARD, clone, pad, setListRule, isList: p => isList(p), applyOp, applyBatch, cmpOrder, entry, keyOf, replay, stateDigest,
  setBinaryCodec, setCodecMode, codecMode, isBinary, encodeSegment, decodeSegment, encodePack, encodeSnapshot, decodeSnapshot, segmentExt, parsePath, checkSegment, sizeCheck,
  planPacks, packBody, unpack, makeSnapshot, useSnapshot };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Exp7Sync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
