#!/usr/bin/env node
// Tiny in-memory mock of the GitHub REST endpoints used by clients/client.html (multi-account, multi-repo).
// Node built-ins only. SYNTHETIC test data only; mock tokens are fake strings.
// Usage: node tools/mock_github.js [--port 18799]
// Runtime knobs (GET):
//   /__mock/config?fail403=N&failPut409=N&createForbidden=0|1&revoke=<token>|all|none
//   /__mock/mkrepo?full=owner/name&init=0|1&private=0|1     (pre-create a repo; init=0 -> empty repo, no branch)
//   /__mock/state                                            (all repos, commits, files; never tokens)
// Synthetic Bearer tokens (fake, test-only). <login> = first dash-separated word, an optional -suffix is ignored:
//   test-valid-<login>[-x]    -> login <login>; full write to repos OWNED by <login>; can POST /user/repos
//   test-readonly-<login>[-x] -> login <login>; own repos permissions.push false, PUT 403
//   anything else / revoked   -> 401 on every endpoint (a request with NO Authorization header is anonymous)
// Like real fine-grained PATs, a token can never write to a repo owned by another account (403), whatever the role.
// Anonymous and authenticated reads of PUBLIC repos are allowed; private repos are 404 to everyone but the owner.
'use strict';
const http = require('http'), crypto = require('crypto'), url = require('url');
const args = process.argv.slice(2); const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = +arg('--port', 18799);
if (PORT === 8765 || PORT === 8791) { console.error('port not allowed'); process.exit(1); }
const cfg = { fail403: 0, failPut409: 0, createForbidden: 0 }; const revoked = new Set(); let revokeAll = false;
const rates = new Map(); const RESET = () => Math.floor(Date.now() / 1000) + 3600;
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const repos = new Map(); // lower(full) -> {full, owner, name, private, commits:[{sha,message,tree:Map(path->{sha,content}),files}]}
const blobs = new Map(); // sha -> content b64
function mkrepo(full, init, priv) {
  const [owner, name] = full.split('/'); const r = { full, owner, name, private: !!priv, commits: [] };
  if (init) { const c = Buffer.from('# ' + name + '\n').toString('base64'); const b = sha1('blob ' + c); blobs.set(b, c); r.commits.push({ sha: sha1(full + 'init' + Math.random()), message: 'Initial commit', tree: new Map([['README.md', { sha: b }]]), files: ['README.md'] }); }
  repos.set(full.toLowerCase(), r); return r;
}
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
  const h = req.headers.authorization; if (!h) return { anon: true };
  const m = h.match(/^(?:token|Bearer) (test-(valid|readonly)-([a-z0-9]+)(?:-[a-z0-9-]*)?)$/i);
  if (!m || revokeAll || revoked.has(m[1])) return null;
  return { token: m[1], kind: m[2].toLowerCase(), login: m[3].toLowerCase() };
}
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }
const UNAUTH = { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' };
const NF = { message: 'Not Found' };

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname; const raw = await body(req);
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  // ---- mock control ----
  if (p === '/__mock/config') { for (const k of ['fail403', 'failPut409', 'createForbidden']) if (u.query[k] != null) cfg[k] = +u.query[k]; const rv = u.query.revoke; if (rv === 'all') revokeAll = true; else if (rv === 'none') { revokeAll = false; revoked.clear(); } else if (rv) revoked.add(rv); return send(res, 200, Object.assign({ revokeAll, revoked: revoked.size }, cfg)); }
  if (p === '/__mock/mkrepo') { const r = mkrepo(u.query.full, u.query.init !== '0', u.query.private === '1'); return send(res, 200, { full: r.full, commits: r.commits.length }); }
  if (p === '/__mock/state') return send(res, 200, Object.fromEntries([...repos.values()].map(r => [r.full, { private: r.private, commits: r.commits.map(c => ({ sha: c.sha, message: c.message, files: c.files })), paths: r.commits.length ? [...r.commits[r.commits.length - 1].tree.keys()] : [] }])));
  let js = {}; try { js = JSON.parse(raw); } catch {}
  const who = auth(req);
  if (!who) return send(res, 401, UNAUTH);
  const rk = who.anon ? 'anon' : who.login; if (!rates.has(rk)) rates.set(rk, who.anon ? 60 : 5000);
  const limit = who.anon ? '60' : '5000';
  const rl = () => ({ 'X-RateLimit-Limit': limit, 'X-RateLimit-Remaining': String(rates.get(rk)), 'X-RateLimit-Reset': String(RESET()) });
  const spend = n => rates.set(rk, Math.max(0, rates.get(rk) - n));
  // ---- /user ----
  if (p === '/user' && req.method === 'GET') { if (who.anon) return send(res, 401, { message: 'Requires authentication' }, rl()); spend(1); return send(res, 200, { login: who.login, id: 1, type: 'User' }, rl()); }
  if (p === '/user/repos' && req.method === 'POST') {
    if (who.anon) return send(res, 401, { message: 'Requires authentication' }, rl());
    if (cfg.createForbidden || who.kind !== 'valid') return send(res, 403, { message: 'Resource not accessible by personal access token' }, rl());
    if (!js.name) return send(res, 422, { message: 'Validation Failed' }, rl());
    const full = `${who.login}/${js.name}`;
    if (repos.has(full.toLowerCase())) return send(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }, rl());
    spend(5); const r = mkrepo(full, !!js.auto_init, !!js.private);
    return send(res, 201, { full_name: r.full, private: r.private, default_branch: 'main', permissions: { admin: true, push: true, pull: true } }, rl());
  }
  // ---- /repos/{owner}/{name}/... ----
  const m0 = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m0) return send(res, 404, NF, rl());
  const repo = repos.get(`${m0[1]}/${m0[2]}`.toLowerCase()); const rest = m0[3] || '';
  const isOwner = !who.anon && repo && repo.owner.toLowerCase() === who.login;
  if (!repo || (repo.private && !isOwner)) return send(res, 404, NF, rl());
  const head = () => repo.commits[repo.commits.length - 1];
  if (rest === '' && req.method === 'GET') {
    spend(1); const perms = who.anon ? undefined : { admin: isOwner && who.kind === 'valid', maintain: false, push: isOwner && who.kind === 'valid', triage: false, pull: true };
    return send(res, 200, Object.assign({ full_name: repo.full, private: repo.private, default_branch: 'main' }, perms ? { permissions: perms } : {}), rl());
  }
  if (rest === '/git/ref/heads/main' && req.method === 'GET') {
    if (!head()) { spend(1); return send(res, 409, { message: 'Git Repository is empty.' }, rl()); }
    const etag = `"${head().sha}"`;
    // like GitHub: 304 is free only when correctly authorized; anonymous 304s still count
    if (req.headers['if-none-match'] === etag) { if (who.anon) spend(1); res.setHeader('ETag', etag); for (const [k, v] of Object.entries(rl())) res.setHeader(k, v); res.writeHead(304); return res.end(); }
    spend(1);
    return send(res, 200, { ref: 'refs/heads/main', object: { sha: head().sha, type: 'commit' } }, Object.assign({ ETag: etag }, rl()));
  }
  let m;
  if ((m = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/)) && req.method === 'GET') {
    spend(1); const c = repo.commits.find(c => c.sha === m[1]); if (!c) return send(res, 404, NF, rl());
    const tree = []; const dirs = new Set();
    for (const [path, f] of c.tree) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); tree.push({ path, type: 'blob', sha: f.sha, mode: '100644' }); }
    for (const d of dirs) tree.push({ path: d, type: 'tree', sha: sha1('tree' + d), mode: '040000' });
    return send(res, 200, { sha: c.sha, tree: tree.sort((a, b) => a.path < b.path ? -1 : 1), truncated: false }, rl());
  }
  if ((m = rest.match(/^\/git\/blobs\/([0-9a-f]{40})$/)) && req.method === 'GET') {
    spend(1); const c = blobs.get(m[1]); if (c == null) return send(res, 404, NF, rl());
    return send(res, 200, { sha: m[1], encoding: 'base64', content: c }, rl());
  }
  if ((m = rest.match(/^\/contents\/(.*)$/)) && req.method === 'PUT') {
    const path = decodeURIComponent(m[1]);
    if (who.anon) return send(res, 401, { message: 'Requires authentication' }, rl());
    if (!isOwner) return send(res, 403, { message: 'Resource not accessible by personal access token' }, rl()); // other account's repo: never writable
    if (who.kind !== 'valid') return send(res, 403, { message: 'Resource not accessible by personal access token' }, rl());
    if (cfg.fail403 > 0) { cfg.fail403--; return send(res, 403, { message: 'You have exceeded a secondary rate limit (mock)' }, Object.assign({ 'Retry-After': '1' }, rl())); }
    if (cfg.failPut409 > 0) { cfg.failPut409--; return send(res, 409, { message: 'is at X but expected Y (mock)' }, rl()); }
    spend(5);
    if (!js.content || !js.message) return send(res, 422, { message: 'Invalid request: content/message missing' }, rl());
    if (js.branch && js.branch !== 'main') return send(res, 404, { message: 'Branch not found' }, rl());
    const cur = head() && head().tree.get(path);
    if (cur && !js.sha) return send(res, 422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, rl());
    if (cur && js.sha !== cur.sha) return send(res, 409, { message: `${path} does not match ${js.sha}` }, rl());
    const blob = sha1('blob ' + js.content); blobs.set(blob, js.content);
    const tree = new Map(head() ? head().tree : []); tree.set(path, { sha: blob });
    const csha = sha1((head() ? head().sha : 'empty') + repo.full + path + blob + Date.now() + Math.random());
    repo.commits.push({ sha: csha, message: js.message, tree, files: [path] }); // on an empty repo this creates main
    return send(res, cur ? 200 : 201, { content: { path, sha: blob }, commit: { sha: csha, message: js.message } }, rl());
  }
  send(res, 404, NF, rl());
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock github (multi-account) on http://localhost:${PORT}`));
