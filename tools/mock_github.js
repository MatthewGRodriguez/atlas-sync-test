#!/usr/bin/env node
// Tiny in-memory mock of the GitHub endpoints used by clients/client.html.
// Node built-ins only. SYNTHETIC test data only; mock tokens are fake strings.
// Usage: node tools/mock_github.js [--port 18799] [--repo owner/name]
// Runtime knobs: GET /__mock/config?fail403=N&failPut409=N&revoke=<token>|all|none   GET /__mock/state
// Synthetic Bearer tokens (fake, test-only):
//   test-valid-<name>    -> login synthetic-<name>, repo visible, permissions.push true
//   test-readonly-<name> -> login synthetic-<name>, repo visible, connects (client warns), permissions.push false, writes 403
//   test-norepo-<name>   -> login synthetic-<name>, repo not selected (404 on repo endpoints)
//   anything else / missing / revoked -> 401 on /user and every repo endpoint
'use strict';
const http = require('http'), crypto = require('crypto'), url = require('url');
const args = process.argv.slice(2); const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = +arg('--port', 18799);
if (PORT === 8765 || PORT === 8791) { console.error('port not allowed'); process.exit(1); }
const REPO = arg('--repo', 'MatthewGRodriguez/atlas-sync-test');
const ROOT_SHA = arg('--root', '540e077df64c47e115a3bc91a653ecfa50d35238');
const cfg = { fail403: 0, failPut409: 0 }; const revoked = new Set(); let revokeAll = false;
let rate = 5000; const RESET = () => Math.floor(Date.now() / 1000) + 3600;
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
// repo: commits in order; each commit has full tree map path -> {sha, content(b64)}
const commits = [{ sha: ROOT_SHA, message: 'root', tree: new Map(), files: [] }];
const head = () => commits[commits.length - 1];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-None-Match, X-GitHub-Api-Version, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, Link, Location, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Used');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, code, obj, extra = {}) {
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj));
}
function auth(req) {
  const m = (req.headers.authorization || '').match(/^(?:token|Bearer) (test-(valid|readonly|norepo)-([a-z0-9-]+))$/i);
  if (!m || revokeAll || revoked.has(m[1])) return null;
  return { token: m[1], kind: m[2].toLowerCase(), login: 'synthetic-' + m[3] };
}
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname; const raw = await body(req);
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  // ---- mock control ----
  if (p === '/__mock/config') { for (const k of ['fail403', 'failPut409']) if (u.query[k] != null) cfg[k] = +u.query[k]; const rv = u.query.revoke; if (rv === 'all') revokeAll = true; else if (rv === 'none') { revokeAll = false; revoked.clear(); } else if (rv) revoked.add(rv); return send(res, 200, Object.assign({ revokeAll, revoked: revoked.size }, cfg)); }
  if (p === '/__mock/state') return send(res, 200, { commits: commits.map(c => ({ sha: c.sha, message: c.message, files: c.files })), paths: [...head().tree.keys()] });
  const form = Object.fromEntries(new URLSearchParams(raw)); let js = {}; try { js = JSON.parse(raw); } catch {}
  const f = Object.assign({}, js, form);
  // ---- REST API ----
  const rl = { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': String(rate), 'X-RateLimit-Reset': String(RESET()) };
  const who = auth(req);
  const UNAUTH = { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' };
  if (p === '/user') { if (!who) return send(res, 401, UNAUTH, rl); rate--; return send(res, 200, { login: who.login, id: 1, type: 'User' }, rl); }
  const base = `/repos/${REPO}`;
  if (p !== base && !p.startsWith(base + '/')) return send(res, who ? 404 : 401, who ? { message: 'Not Found' } : UNAUTH, rl);
  if (!who) return send(res, 401, UNAUTH, rl);
  if (who.kind === 'norepo') return send(res, 404, { message: 'Not Found' }, rl);
  const rest = p.slice(base.length);
  if (rest === '' && req.method === 'GET') { rate--; return send(res, 200, { full_name: REPO, private: false, default_branch: 'main', permissions: { admin: false, maintain: false, push: who.kind === 'valid', triage: false, pull: true } }, rl); }
  if (rest === '/git/ref/heads/main' && req.method === 'GET') {
    const etag = `"${head().sha}"`;
    if (req.headers['if-none-match'] === etag) { res.setHeader('ETag', etag); for (const [k, v] of Object.entries(rl)) res.setHeader(k, v); res.writeHead(304); return res.end(); }
    rate--; rl['X-RateLimit-Remaining'] = String(rate);
    return send(res, 200, { ref: 'refs/heads/main', object: { sha: head().sha, type: 'commit' } }, Object.assign({ ETag: etag }, rl));
  }
  let m;
  if ((m = rest.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/)) && req.method === 'GET') {
    rate--; rl['X-RateLimit-Remaining'] = String(rate);
    const bi = commits.findIndex(c => c.sha === m[1]), hi = commits.findIndex(c => c.sha === m[2]);
    if (bi < 0 || hi < 0) return send(res, 404, { message: 'Not Found' }, rl);
    const cs = commits.slice(bi + 1, hi + 1); const files = new Map();
    for (const c of cs) for (const fl of c.files) files.set(fl, { filename: fl, status: 'added', sha: c.tree.get(fl).sha });
    return send(res, 200, { status: cs.length ? 'ahead' : 'identical', ahead_by: cs.length, total_commits: cs.length, commits: cs.map(c => ({ sha: c.sha, commit: { message: c.message } })), files: [...files.values()] }, rl);
  }
  if ((m = rest.match(/^\/contents\/(.*)$/))) {
    const path = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      rate--; rl['X-RateLimit-Remaining'] = String(rate);
      const c = u.query.ref ? commits.find(c => c.sha === u.query.ref) : head(); if (!c) return send(res, 404, { message: 'No commit found for the ref' }, rl);
      const fobj = c.tree.get(path);
      if (fobj) return send(res, 200, { type: 'file', path, sha: fobj.sha, encoding: 'base64', content: fobj.content }, rl);
      const kids = new Map(); for (const k of c.tree.keys()) if (k.startsWith(path + '/')) { const n = k.slice(path.length + 1).split('/')[0]; kids.set(n, k.slice(path.length + 1).includes('/') ? 'dir' : 'file'); }
      if (!kids.size) return send(res, 404, { message: 'Not Found' }, rl);
      return send(res, 200, [...kids].map(([n, t]) => ({ name: n, path: path + '/' + n, type: t })), rl);
    }
    if (req.method === 'PUT') {
      if (who.kind !== 'valid') return send(res, 403, { message: 'Resource not accessible by personal access token' }, rl);
      if (cfg.fail403 > 0) { cfg.fail403--; return send(res, 403, { message: 'You have exceeded a secondary rate limit (mock)' }, Object.assign({ 'Retry-After': '1' }, rl)); }
      if (cfg.failPut409 > 0) { cfg.failPut409--; return send(res, 409, { message: 'is at X but expected Y (mock)' }, rl); }
      rate -= 5; rl['X-RateLimit-Remaining'] = String(rate);
      if (!f.content || !f.message) return send(res, 422, { message: 'Invalid request: content/message missing' }, rl);
      const cur = head().tree.get(path);
      if (cur && !f.sha) return send(res, 422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, rl);
      if (cur && f.sha !== cur.sha) return send(res, 409, { message: `${path} does not match ${f.sha}` }, rl);
      if (!cur && f.sha) return send(res, 422, { message: 'sha given for a new file' }, rl);
      const blob = sha1('blob ' + f.content); const tree = new Map(head().tree); tree.set(path, { sha: blob, content: f.content });
      const csha = sha1(head().sha + path + blob + Date.now() + Math.random());
      commits.push({ sha: csha, message: f.message, tree, files: [path] });
      return send(res, cur ? 200 : 201, { content: { path, sha: blob }, commit: { sha: csha, message: f.message } }, rl);
    }
  }
  send(res, 404, { message: 'Not Found' }, rl);
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock github on http://localhost:${PORT} repo=${REPO}`));
