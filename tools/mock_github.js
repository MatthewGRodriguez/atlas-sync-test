#!/usr/bin/env node
// Tiny in-memory mock of the GitHub endpoints used by clients/client.html.
// Node built-ins only. SYNTHETIC test data only; mock tokens are fake strings.
// Usage: node tools/mock_github.js [--port 18799] [--device-cors 1|0] [--repo owner/name]
// Runtime knobs: GET /__mock/config?deviceCors=0|1&fail403=N&failPut409=N   GET /__mock/state
'use strict';
const http = require('http'), crypto = require('crypto'), url = require('url');
const args = process.argv.slice(2); const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = +arg('--port', 18799);
if (PORT === 8765 || PORT === 8791) { console.error('port not allowed'); process.exit(1); }
const REPO = arg('--repo', 'MatthewGRodriguez/atlas-sync-test');
const ROOT_SHA = arg('--root', '540e077df64c47e115a3bc91a653ecfa50d35238');
const cfg = { deviceCors: arg('--device-cors', '1') === '1', fail403: 0, failPut409: 0 };
let rate = 5000; const RESET = () => Math.floor(Date.now() / 1000) + 3600;
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
// repo: commits in order; each commit has full tree map path -> {sha, content(b64)}
const commits = [{ sha: ROOT_SHA, message: 'root', tree: new Map(), files: [] }];
const head = () => commits[commits.length - 1];
const devices = new Map(); // device_code -> {user_code, polls, login}
let devN = 0;

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
function login(req) {
  const a = req.headers.authorization || ''; const m = a.match(/^(?:token|Bearer) (mock-[a-z0-9-]+)$/i);
  return m ? m[1].replace(/^mock-tok-/, '').replace(/-\d+$/, '') : null;
}
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname; const raw = await body(req);
  const isAuth = p.startsWith('/login/');
  if (!isAuth || cfg.deviceCors) cors(res);
  if (req.method === 'OPTIONS') { if (isAuth && !cfg.deviceCors) return send(res, 404, { message: 'Not Found' }); res.writeHead(204); return res.end(); }
  // ---- mock control ----
  if (p === '/__mock/config') { for (const k of ['fail403', 'failPut409']) if (u.query[k] != null) cfg[k] = +u.query[k]; if (u.query.deviceCors != null) cfg.deviceCors = u.query.deviceCors === '1'; return send(res, 200, cfg); }
  if (p === '/__mock/state') return send(res, 200, { commits: commits.map(c => ({ sha: c.sha, message: c.message, files: c.files })), paths: [...head().tree.keys()] });
  // ---- device flow ----
  const form = Object.fromEntries(new URLSearchParams(raw)); let js = {}; try { js = JSON.parse(raw); } catch {}
  const f = Object.assign({}, js, form);
  if (p === '/login/device/code' && req.method === 'POST') {
    if (!f.client_id) return send(res, 400, { error: 'unauthorized_client' });
    const dc = 'mockdev' + (++devN); const uc = 'MOCK-' + String(1000 + devN);
    devices.set(dc, { user_code: uc, polls: 0, login: 'synthetic-user-' + devN });
    return send(res, 200, { device_code: dc, user_code: uc, verification_uri: `http://localhost:${PORT}/login/device`, expires_in: 900, interval: 1 });
  }
  if (p === '/login/device' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>Mock device page: codes are auto-approved after the first poll.</p>'); }
  if (p === '/login/oauth/access_token' && req.method === 'POST') {
    const d = devices.get(f.device_code); if (!d) return send(res, 200, { error: 'bad_verification_code' });
    if (d.polls++ < 1) return send(res, 200, { error: 'authorization_pending' });
    return send(res, 200, { access_token: `mock-tok-${d.login}-${Date.now()}`, token_type: 'bearer', scope: f.scope || '' });
  }
  // ---- REST API ----
  const rl = { 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': String(rate), 'X-RateLimit-Reset': String(RESET()) };
  const who = login(req);
  if (p === '/user') { if (!who) return send(res, 401, { message: 'Requires authentication' }, rl); rate--; return send(res, 200, { login: who, id: 1, type: 'User' }, rl); }
  const base = `/repos/${REPO}`;
  if (!p.startsWith(base)) return send(res, 404, { message: 'Not Found' });
  const rest = p.slice(base.length);
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
      if (!who) return send(res, 401, { message: 'Requires authentication' }, rl);
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
server.listen(PORT, '127.0.0.1', () => console.log(`mock github on http://localhost:${PORT} repo=${REPO} deviceCors=${cfg.deviceCors}`));
