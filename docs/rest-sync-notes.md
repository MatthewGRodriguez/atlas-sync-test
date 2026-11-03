# REST-only sync notes for Exp7 atlas clients

Date: 2026-11-02. Legend: **[V-curl]** verified by curl this session · **[V-docs]** read in current docs.github.com this session · **[A]** assumed / from prior knowledge, needs a live test.

## (a) Signing in from a static HTML page

| Option | Works from file:// or plain http page? | Notes |
|---|---|---|
| OAuth web flow | **No, not alone** | Token exchange `POST github.com/login/oauth/access_token` requires `client_secret` [V-docs] (PKCE is supported and "strongly recommended" but the secret is still listed as required [V-docs]). Docs: "CORS pre-flight requests (OPTIONS) are not supported" [V-docs]; curl to that endpoint with an Origin header returned no `Access-Control-*` headers [V-curl]. Also needs a registered redirect URL; `file://` cannot be one [A]. Docs: never put client secret in client code [V-docs]. |
| Device flow | **No, not directly** | No client secret needed [V-docs]; must be enabled in app settings [V-docs]. But `POST github.com/login/device/code` and `/login/oauth/access_token` returned **no `Access-Control-Allow-Origin`** for `Origin: null` or `Origin: http://localhost:8798`; OPTIONS preflight returned 404 [V-curl] (tested with a dummy client_id → 404 body; header absence is the point). So browser `fetch` will be blocked by CORS. |
| GitHub App user tokens | Same as above | Uses the same web/device endpoints, so same CORS wall [A, by endpoint identity]. Benefit: fine-grained repo permissions, 8h expiring tokens + refresh [V-docs for OAuth expiring tokens; GitHub App behaviour A]. |
| Fine-grained PAT pasted into page | **Yes** | api.github.com sends `Access-Control-Allow-Origin: *` and allows `Authorization` header and GET/POST/PATCH/PUT/DELETE [V-curl]. Create at Settings → Developer settings → Fine-grained tokens: Resource owner = user, **Only select repositories = atlas-sync-test**, Repository permissions **Contents: Read and write** (Metadata: read is added automatically) [A, standard UI]. Set short expiry (e.g. 7 days) [A: max/policy details not re-checked]. Each tester uses their own PAT → commits attributed to them. **Correction (2026-11-02):** a fine-grained PAT can only write to repos owned by its resource owner (the token's own account, or an org it targets); being a collaborator on another user's repo does **not** grant the token write access. Earlier text here said collaborators could write; that was wrong. Hence the per-writer repo design in (d). |
| CORS proxy | Yes, with a proxy | A tiny proxy (e.g. Cloudflare Worker, free tier) forwards device-flow calls and adds CORS headers. No secret needed for device flow, so the proxy can be stateless. But it is "a backend of ours" and a third party sees tokens in transit. Public CORS proxies: do not use with tokens. [A] |

**Decision (Matthew, 2026-11-02):** everything stays inside the single HTML file, **no proxy of any kind**, sign-in = **pasted fine-grained PAT**. The device-flow code and proxy option were removed from `client.html` (the device flow was blocked by CORS on Matthew's Mac, as predicted above).

**Implemented sign-in in `clients/client.html`:**
- **Sign in with GitHub** navigates the same tab (then browser Back to return and paste) to `https://github.com/settings/personal-access-tokens/new?name=Atlas%20sync&description=Static%20page%20access&expires_in=30&contents=write`. On-page steps: Only select repositories → `<your-login>/atlas-sync-log` (your own repo), confirm Contents: Read and write, Generate token, paste. Optional checkbox appends `&administration=write` (only needed for the API repo-creation path, see (d)).
- Password-type field + **Connect**: `GET /user` (shows login), then `GET /repos/{login}/{repoName}`: 401 → token wrong/expired/revoked; 404 → repo does not exist yet (offer Create); `permissions.push === false` → warning (connects anyway; first refused write says so). If `permissions` is absent the first write confirms access [A: whether fine-grained PATs always return `permissions` on this endpoint is not verified live].
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
  snapshot.bin          # compact binary snapshot at log position N (binary only since 2026-11-03)
  snapshot.meta.json    # {"baseSeq":{"writerA":120,...},"commit":"<sha>"}
  log/<writerId>/<seq-start>.bin   # append-only segments, ONE DIRECTORY PER WRITER
  # (legacy .json segments from earlier tests are read-only; nothing writes .json any more)
```

- **One log per writer** (recommended): each writer only creates new segment files in its own folder, so Contents PUT never has a blob-sha conflict with another writer. Creating a new file still makes a commit on `main`; GitHub serializes these server-side, so concurrent creates of *different* paths should both succeed, but may occasionally 409 under contention → retry [A, live test]. Alternative "one shared log with CAS" works but every writer contends on one sha; fine for 2 clients, poor for many.
- **Segment size**: start a new segment per accepted batch (or roll at ~256 KB) so files stay ≪1 MB and writes stay ≪80/min.
- **Commit mapping**: one accepted proposal batch → one commit (Contents PUT creating one segment). Commit message: `atlas:<atlasId> writer:<id> seq:<a>-<b>`. Use the Git Data API only for compaction (new snapshot + meta + deleting old segments atomically).
- **Revisions per path**: each log record = `{writer, seq, path, baseRev, newRev, op, payload}`; `rev` for a path = (writer, seq) of the last record that touched it; readers apply records in a deterministic order (e.g. commit order, ties by writer/seq) and detect conflicts where `baseRev` ≠ current rev → conflict handled by the format's merge rule (LWW or flagged) [design assumption for Matthew].
- **Polling**: `GET /git/ref/heads/main` with If-None-Match every 5–10 s per client. 304s are free on the primary limit [V-docs] but still count toward secondary points (1/GET, 900/min/endpoint) [V-docs] — fine for a handful of clients. On change: `compare/{old}...{new}` → fetch new segment files by path at the new commit sha.
- **"changed" event** (client-side): `{type:"changed", atlasId, fromCommit, toCommit, records:[{writer,seq,path,rev,op}], conflicts:[...]}`.
- **Compaction**: a designated client (or manual) writes a new snapshot + meta via one Git Data commit with fast-forward-only ref update.

## (d) Multi-user design: one public log repo per writer (current)

**Decision (Matthew, 2026-11-02):** nobody hands over tokens for the account that owns a shared repo. Each writer:
- owns a **public** repo `<login>/atlas-sync-log` (name configurable) and writes only there: `log/<writerId>/<seq 6 digits>.bin`, one Contents API `PUT` per batch, no `branch` field (default branch). `writerId` defaults to the GitHub login.
- reads every repo in `[own, ...peers]`. Peers are `owner/repo` strings (comma/newline separated), kept in `sessionStorage` and the `?peers=` URL param. "Copy" shares your own `owner/repo`; "Copy share link" builds a link with `?peers=` (no token, no writer id).

**Reading a repo** (anonymous if signed out, else with the token for the higher limit): `GET /repos/{o}/{r}/git/ref/heads/main` with `If-None-Match` → 304 = nothing new; 409 = empty repo (no branch yet); 200 with a new sha → `GET /git/trees/{sha}?recursive=1`, then `GET /git/blobs/{sha}` for each unseen `log/<w>/<seq>` file (blobs are immutable). A segment whose `writer`/`seq` disagree with its path is ignored. [Endpoints: A, standard; 409-on-empty for git refs: docs say refs cannot be created on empty repos [V-docs], the exact 409 body for GET is A.]

**Merge order.** There is no shared commit order across repos, so every segment carries `ts` (writer's clock, ms since epoch; `createdAt` ISO as fallback) and replay sorts by **(ts, writerId, seq, repo)**; the full log is replayed from the seed on every change, so a late-arriving older segment slots into place. Op rules unchanged: `set`/`ref` last-write-wins, `delta` adds, `add` on existing list member is a no-op, `remove` missing is a no-op. A writer's own `ts` is forced strictly increasing (`max(now, last+1)`), so its own batches stay in seq order.

**Honest caveats:**
- **Clock skew decides conflicts.** If Alice's clock is 2 minutes fast, her edits beat Bob's edits made in those 2 minutes, even if Bob's came later in real time. No server time is involved. A hybrid logical clock (ts = max(now, highest ts seen + 1)) would fix causality for edits made after seeing the other's; not done yet.
- **History can reorder.** A peer that was offline and pushes old-ts segments later changes the replayed result retroactively (the CHANGED event appears when the late segment arrives). Fine for this test; real use needs compaction/snapshot rules.
- **Trust:** each repo owner can write any `writerId` folder in their own repo; the client does not yet bind writerId to the repo owner. Deleting/rewriting your own history is possible (it is your repo).
- **Visibility delay** between a write and reads by others on api.github.com: unmeasured [A].
- Recursive tree listing truncates at very large trees (flagged in the UI) [V-docs general; limit A].

**Polling and limits.** Default 10 s per round (exposed as "Poll every"), exponential backoff (×2 up to ×32, capped at 600 s) after errors or 403/429. Signed in: 304s with a valid `Authorization` header don't count against the primary limit [V-docs, best-practices page re-read 2026-11-02]. **Anonymous: 60 requests/hour per IP, and anonymous 304s DO count** (the free-304 rule requires authorization) [V-docs], so signed-out readers use a floor of 72 s × number of repos (≈50 req/h), shown in Status as the effective interval.

**Empty repos.** The first `PUT /contents/...` on a repo with no commits creates the default branch [A: widely relied on and matches the Contents API using "the repository's default branch"; not verified live this session]. The client sends no `branch`, treats a 409 on the ref as "empty, no segments", and the button creates repos with `auto_init:true` anyway.

**One-click repo creation (what the docs say, 2026-11-02):**
- `POST /user/repos` **is** listed for fine-grained PATs: the "Permissions required for fine-grained personal access tokens" page lists it under **Administration: write** and also under a separate **"Repository creation"** permission [V-docs]. The token-prefill URL docs list `administration` (read/write) but no key for "Repository creation" [V-docs], so the page can only prefill `&administration=write`. api.github.com CORS allows POST [V-curl earlier].
- Not verified live: whether a token with **Only select repositories** can create a repo (a not-yet-existing repo cannot be selected, so it likely needs **All repositories** + Administration: write, a broad token) [A]. Because of that, the default token URL stays `contents=write` only; `&administration=write` is added only if the user ticks "token may also create my repo".
- The button: signed in → `GET /repos/{login}/{name}` (exists → use it) → `POST /user/repos {name, private:false, auto_init:true, description}`; 201 or 422 "already exists" → use it; 403/404 → fall back. Signed out or fallback → same-tab `https://github.com/new?name=atlas-sync-log&visibility=public&description=Atlas%20sync%20log`. The `name`, `description`, `visibility`, `owner` query params are documented [V-docs "Creating a new repository from a URL query" + changelog 2023-04-27]; invalid params are ignored. There is no documented param to pre-tick "Add a README", so the repo may be empty (handled). Non-secret UI state is saved in sessionStorage before navigating; after Back (bfcache or reload) the page re-checks the repo if a token is present.

## Needs live test
1. Concurrent Contents PUTs creating different files on the same branch: conflict rate and exact status code.
2. Git Data ref PATCH non-fast-forward → 422 message.
3. Fine-grained PAT from `file://` (Origin null) end-to-end PUT to the writer's own repo, including the first PUT on an empty repo.
6. `POST /user/repos` with a fine-grained PAT (Administration: write; Only select vs All repositories).
7. Anonymous peer polling against real limits; `GET git/ref/heads/main` status on an empty repo (expected 409).
8. Two real accounts (Matthew + a second tester) reading each other's public repos.
4. 304 with Authorization really leaves `x-ratelimit-remaining` unchanged.
5. Propagation delay between a write and `compare`/ref reads on api.github.com.

## Exp7 sync core, codec, compaction, CLI (2026-11-02)
- The core was extracted to `clients/exp7-sync-core.js` and inlined in the page. Node (CLI, tests) runs the same code, and page and Node replay
  give byte-identical results (e2e_more_test).
- Retroactive events: event dedupe keys include the previous owner, so a late segment that sorts in front is reported.
- Size: a 5000-op segment is 391,865 B as JSON (over the 256 KB soft limit, allowed up to the 1 MB hard limit) and 9,721 B as atlas/1 binary.
- The mock gained the Git Data API (blobs, trees with sha:null deletes, commits, and a fast-forward-only ref PATCH with 422).

## Binary codec is the primary write format (2026-11-02, Matthew's decision)
- Segments, packs and snapshots are written as binary atlas/1 (`.bin`, `JRBA` magic) by default; `?codec=json` / **Write JSON (debug)**
  in the page and `--codec json` in the CLI write JSON. Readers detect the format by magic bytes, so mixed logs replay identically.
- File names come from the bytes actually written (`extOf`), so a fallback batch is always `.json`, never JSON bytes in a `.bin` file.
- Codec availability without a backend: embedded copy in `client.html` (`tools/embed_codec.js`, page ~590 KB vs ~68 KB stripped), else
  `atlas_codec.bundle.js` next to the page, loaded once at startup; writes wait for that load. The public repo ships the page stripped,
  because the codec is the Artist's code (ADR 0111); embedding it publicly needs Matthew's explicit OK.
- (Superseded 2026-11-03, see below.)
- Size limits are unchanged (256 KB soft, 1 MB hard per segment/pack); binary makes them far easier to meet (5000 ops: 9,721 B vs 391,865 B).

## Binary only; JSON read-only legacy (2026-11-03, Matthew's decision, ADR 0113)
- Binary atlas/1 is the **only** write format for segments, packs and snapshots (page and CLI). Removed: the JSON write path,
  `?codec=json`, **Write JSON (debug)**, CLI `--codec json`, and the fallback-to-JSON-on-codec-failure behaviour. The section above
  ("primary write format") is superseded where it mentions JSON writes or the fallback.
- Changes still never fail: no codec / load failure / encode exception -> `encode*()` throws, nothing is written to GitHub in any format,
  the batch stays queued in op form (page: memory + sessionStorage `atlasSyncQueue`, never the token; CLI: `outbox.json` + a `queued`
  journal line, exit 4) with a visible "codec required to write" error. The page retries the codec load and drains the queue as `.bin`;
  the CLI writes it on the next `flush`/`propose` with a codec.
- Kept: the read-only JSON decoder (magic-byte detect), so `.json` segments from earlier tests still replay. Removing it was not
  trivially safe (existing test logs and the CLI/page readers depend on it); it can go once no `.json` logs remain.
- The public page ships without the codec, so it cannot write on its own; it shows **Codec required to write** and still reads legacy
  `.json` (binary needs the codec). The private embedded build (tools/embed_codec.js) writes `.bin`.
