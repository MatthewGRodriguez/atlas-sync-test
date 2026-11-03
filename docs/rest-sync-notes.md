# REST-only sync notes for Exp7 atlas clients

Date: 2026-11-02. Legend: **[V-curl]** verified by curl this session · **[V-docs]** read in current docs.github.com this session · **[A]** assumed / from prior knowledge, needs a live test.

## (a) Signing in from a static HTML page

| Option | Works from file:// or plain http page? | Notes |
|---|---|---|
| OAuth web flow | **No, not alone** | Token exchange `POST github.com/login/oauth/access_token` requires `client_secret` [V-docs] (PKCE is supported and "strongly recommended" but the secret is still listed as required [V-docs]). Docs: "CORS pre-flight requests (OPTIONS) are not supported" [V-docs]; curl to that endpoint with an Origin header returned no `Access-Control-*` headers [V-curl]. Also needs a registered redirect URL; `file://` cannot be one [A]. Docs: never put client secret in client code [V-docs]. |
| Device flow | **No, not directly** | No client secret needed [V-docs]; must be enabled in app settings [V-docs]. But `POST github.com/login/device/code` and `/login/oauth/access_token` returned **no `Access-Control-Allow-Origin`** for `Origin: null` or `Origin: http://localhost:8798`; OPTIONS preflight returned 404 [V-curl] (tested with a dummy client_id → 404 body; header absence is the point). So browser `fetch` will be blocked by CORS. |
| GitHub App user tokens | Same as above | Uses the same web/device endpoints, so same CORS wall [A, by endpoint identity]. Benefit: fine-grained repo permissions, 8h expiring tokens + refresh [V-docs for OAuth expiring tokens; GitHub App behaviour A]. |
| Fine-grained PAT pasted into page | **Yes** | api.github.com sends `Access-Control-Allow-Origin: *` and allows `Authorization` header and GET/POST/PATCH/PUT/DELETE [V-curl]. Create at Settings → Developer settings → Fine-grained tokens: Resource owner = user, **Only select repositories = atlas-sync-test**, Repository permissions **Contents: Read and write** (Metadata: read is added automatically) [A, standard UI]. Set short expiry (e.g. 7 days) [A: max/policy details not re-checked]. Each tester uses their own PAT → commits attributed to them. Non-owners need to be collaborators on the repo to write [A]. |
| CORS proxy | Yes, with a proxy | A tiny proxy (e.g. Cloudflare Worker, free tier) forwards device-flow calls and adds CORS headers. No secret needed for device flow, so the proxy can be stateless. But it is "a backend of ours" and a third party sees tokens in transit. Public CORS proxies: do not use with tokens. [A] |

**Decision (Matthew, 2026-11-02):** everything stays inside the single HTML file, **no proxy of any kind**, sign-in = **pasted fine-grained PAT**. The device-flow code and proxy option were removed from `client.html` (the device flow was blocked by CORS on Matthew's Mac, as predicted above).

**Implemented sign-in in `clients/client.html`:**
- **Sign in with GitHub** navigates the same tab (then browser Back to return and paste) to `https://github.com/settings/personal-access-tokens/new?name=Atlas%20sync&description=Static%20page%20access&expires_in=30&contents=write`. On-page steps: Only select repositories → `MatthewGRodriguez/atlas-sync-test`, confirm Contents: Read and write, Generate token, paste.
- Password-type field + **Connect**: `GET /user` (shows login), then `GET /repos/{repo}`: 401 → token wrong/expired/revoked; 404/403 → repo not selected; `permissions.push === false` → lacks write access. If `permissions` is absent the first write confirms access [A: whether fine-grained PATs always return `permissions` on this endpoint is not verified live].
- Token in memory only by default; "Remember for this tab" uses `sessionStorage`; never `localStorage`; masked in diagnostics. **Sign out** clears memory + sessionStorage and stops polling. Any 401 mid-session (poll, read, write) signs out with a clear message.
- `?api=` overrides the API base (tests use the mock on port 18799).

**Honest note:** this is a pasted token. GitHub offers no sign-in for a static page without a backend. The user handles the token, can over-scope it by mistake, and must revoke it on GitHub (Settings → Developer settings → Fine-grained tokens) when done.

**Honest limits:** any secret in a static page is public; tokens in localStorage are readable by any script on that origin (XSS) and, for `file://`, origin handling varies by browser (Chrome treats file pages as opaque origin `null`) [A]; a PAT is user-handled and can be over-scoped by mistake; there is no server to revoke on logout.

## (b) REST endpoints

- **CORS on api.github.com** [V-curl]: GET with `Origin: null` and `Origin: http://localhost:8798` → `access-control-allow-origin: *`; exposed headers include `ETag, Link, Location, Retry-After, X-RateLimit-*, X-Poll-Interval`. Preflight OPTIONS for PUT → 204, `access-control-allow-methods: GET, POST, PATCH, PUT, DELETE`, `access-control-allow-headers` includes `Authorization, Content-Type, If-Match, If-None-Match, If-Modified-Since, X-GitHub-Api-Version`, `access-control-max-age: 86400`.
- **Contents API** `GET/PUT /repos/{o}/{r}/contents/{path}` [V-docs]: content is Base64; update requires the current blob `sha` (acts as compare-and-swap); responses 409 Conflict / 422 on failure. Files ≤1 MB fully supported; 1–100 MB only via raw/object media types (`application/vnd.github.raw+json`); >100 MB unsupported. Docs warn PUT and DELETE in parallel conflict, "use serially". Each PUT = one commit. Directory listing caps at 1,000 entries (use Trees API beyond).
- **Git Data API** (blobs → tree with `base_tree` → commit with parent → `PATCH /git/refs/heads/main` with `force:false`) gives one atomic multi-file commit; the ref update is rejected (422 "not a fast forward") if main moved [A: from prior docs knowledge, not re-fetched; needs live test]. Costs ~4+N writes per commit.
- **Conditional requests** [V-docs]: ETag/If-None-Match; a 304 **does not count** against the primary limit *when sent with a valid Authorization header*. Curl (unauth) got a 304 with `x-ratelimit-remaining` unchanged [V-curl, consistent]. Conditional PUT/POST/PATCH not supported.
- **What changed since**: `GET /repos/{o}/{r}/commits?sha=main&since=ISO&path=atlas/` (list), or poll `GET /repos/{o}/{r}/git/ref/heads/main` with ETag, then `GET /repos/{o}/{r}/compare/{old}...{new}` for changed files [A: endpoints standard, not re-fetched].
- **raw.githubusercontent.com**: `cache-control: max-age=300` and `access-control-allow-origin: *` [V-curl] → up to ~5 min stale; use api.github.com (raw media type, `?ref=<commit sha>`) for fresh reads; raw URLs pinned to a commit sha are safe to cache.
- **Rate limits** [V-docs]: unauth 60/h per IP (seen `x-ratelimit-limit: 60` [V-curl]); authenticated 5,000/h per user, shared across all PATs/apps of that user. Secondary: ≤100 concurrent; ≤900 points/min per endpoint (GET=1, writes=5); ≤80 content-creating requests/min and ≤500/h; on 403/429 obey `retry-after`, else `x-ratelimit-reset`, else wait ≥60 s with exponential backoff. Best practice: serialize requests, ≥1 s between mutating requests.
- **Concurrent writers**: Contents PUT with stale sha → 409 (sometimes 422) [V-docs status codes; exact code per case A]. Retry: re-GET the file, rebase your record(s) onto the new content (append-only log → just re-append), PUT again with the new sha; jittered backoff, cap retries.

## (c) Proposed layout & protocol

```
atlas/<atlasId>/
  snapshot.bin          # compact binary snapshot at log position N (snapshot.json = debug form)
  snapshot.meta.json    # {"baseSeq":{"writerA":120,...},"commit":"<sha>"}
  log/<writerId>/<seq-start>.bin   # append-only segments, ONE DIRECTORY PER WRITER
  log/<writerId>/<seq-start>.json  # optional debug twin
```

- **One log per writer** (recommended): each writer only creates new segment files in its own folder, so Contents PUT never has a blob-sha conflict with another writer. Creating a new file still makes a commit on `main`; GitHub serializes these server-side, so concurrent creates of *different* paths should both succeed, but may occasionally 409 under contention → retry [A, live test]. Alternative "one shared log with CAS" works but every writer contends on one sha; fine for 2 clients, poor for many.
- **Segment size**: start a new segment per accepted batch (or roll at ~256 KB) so files stay ≪1 MB and writes stay ≪80/min.
- **Commit mapping**: one accepted proposal batch → one commit (Contents PUT creating one segment). Commit message: `atlas:<atlasId> writer:<id> seq:<a>-<b>`. Use the Git Data API only for compaction (new snapshot + meta + deleting old segments atomically).
- **Revisions per path**: each log record = `{writer, seq, path, baseRev, newRev, op, payload}`; `rev` for a path = (writer, seq) of the last record that touched it; readers apply records in a deterministic order (e.g. commit order, ties by writer/seq) and detect conflicts where `baseRev` ≠ current rev → conflict handled by the format's merge rule (LWW or flagged) [design assumption for Matthew].
- **Polling**: `GET /git/ref/heads/main` with If-None-Match every 5–10 s per client. 304s are free on the primary limit [V-docs] but still count toward secondary points (1/GET, 900/min/endpoint) [V-docs] — fine for a handful of clients. On change: `compare/{old}...{new}` → fetch new segment files by path at the new commit sha.
- **"changed" event** (client-side): `{type:"changed", atlasId, fromCommit, toCommit, records:[{writer,seq,path,rev,op}], conflicts:[...]}`.
- **Compaction**: a designated client (or manual) writes a new snapshot + meta via one Git Data commit with fast-forward-only ref update.

## Needs live test
1. Concurrent Contents PUTs creating different files on the same branch: conflict rate and exact status code.
2. Git Data ref PATCH non-fast-forward → 422 message.
3. Fine-grained PAT from `file://` (Origin null) end-to-end PUT.
4. 304 with Authorization really leaves `x-ratelimit-remaining` unchanged.
5. Propagation delay between a write and `compare`/ref reads on api.github.com.
