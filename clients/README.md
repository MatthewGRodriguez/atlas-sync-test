# clients/

`client.html`: a single-file test client (no backend, no proxy). Each writer:

- signs in with a pasted fine-grained personal access token from **their own** GitHub account (the button navigates the same tab to GitHub's prefilled token page; press Back to return and paste; GitHub offers no static-page sign-in without a backend). The token stays in tab memory (optionally sessionStorage), never localStorage, never logged;
- writes one segment per accepted batch to **their own public repo** `<login>/atlas-sync-log` at `log/<writerId>/<seq>.bin` (binary atlas/1, the only write format; writer id defaults to the GitHub login);
- reads every peer repo listed in **Peers** (`owner/repo`, comma/newline separated; also `?peers=`), anonymously if not signed in;
- merges all segments in a deterministic order (writer timestamp, writer id, seq), last write wins; see `../docs/rest-sync-notes.md`.

**Create my log repo**: if signed in, tries `POST /user/repos` (needs a token with Administration: write); if that is refused or you are not signed in, opens `https://github.com/new?name=atlas-sync-log&visibility=public&description=Atlas%20sync%20log` in the same tab, and detects the repo when you come back. An existing repo is simply used.

Fine-grained tokens can only write to repos owned by the token's account; collaborator access does not help. Codec hooks: `encodeSegment/decodeSegment/encodeSnapshot/decodeSnapshot` (write = binary only; read = binary + legacy `.json`). See `../docs/test-runbook.md`.

## Exp7 additions (doc 47)
- `exp7-sync-core.js`: shared core (replay, op rules, LWW order `[ts, writer, seq, repo]`, codec hooks, packs, snapshots).
  It is inlined into `client.html` between the `EXP7-CORE` markers, so the page stays a single file. After you edit it, run
  `node tools/inline_core.js`. Use `--check` in CI.
- **Binary atlas/1 is the only write format** for segments, packs and snapshots (`.bin`, `JRBA` magic; ADR 0113). The JSON write path,
  `?codec=json`, the **Write JSON (debug)** box and the CLI `--codec json` were removed. A read-only decoder for **legacy `.json`**
  segments/packs/snapshots (earlier test logs) is kept, so old logs mixing `.json` and `.bin` still replay to the identical state.
- Where the codec comes from (no backend, no proxy): (1) a copy embedded in `client.html` between the `ATLAS-CODEC` markers
  (`node tools/embed_codec.js` after `tools/build_codec_bundle.sh <codec dir>`; the page becomes ~590 KB, still one file), else
  (2) `atlas_codec.bundle.js` next to the page (or `?codecsrc=URL`), loaded at startup and retried while writes are waiting. The codec is the Artist's code, so the
  **public repo ships the markers empty** (`node tools/embed_codec.js --strip` before committing) and the bundle stays gitignored.
- Changes never fail and are never written in another format: if the codec is missing, fails to load (`?nocodec=1` simulates this) or
  an encode throws, the page shows **Codec required to write** plus a red error, the batch stays **queued** in its op form (mirrored to
  sessionStorage, so a reload keeps it; never the token), the local view still shows it, and nothing is sent to GitHub. The codec load
  is retried (every `?codecretry=` ms, default 10 s, or **Retry codec**); once it works the queue drains as `.bin` and binary segments
  skipped meanwhile are re-read. The **public page ships without the codec**, so on its own it is read-only for binary logs: it reads
  legacy `.json` segments, reports `.bin` segments it cannot decode (no guessing), and cannot write until a codec is next to it or embedded.
- **Compact mine** packs my own contiguous segments into `log/<me>/pack-<first>-<last>.bin` in one fast-forward Git Data
  commit. Packs stay under 256 KB soft and 1 MB hard, and nothing is ever split. Compaction is manual only.
- **Publish snapshot** writes `snapshots/<me>/snap-N`. This is a cache. Readers use it only with `?usesnap=1` and drop it if a late
  segment sorts inside it.
- `atlas-cli.js` (Node 18+): `status | read [prefix] | watch | propose '<ops json>' | flush | digest`. The token comes from env
  `ATLAS_TOKEN` only. It writes only `.bin`, using the codec embedded in `client.html`, else `clients/atlas_codec.bundle.js`
  (`--codec json` is refused). Without a codec (`ATLAS_NO_CODEC=1` simulates that) it writes nothing, keeps the batch in
  `outbox.json`, journals it as `queued`, and exits 4; `flush` writes it as `.bin` once the codec is available. Without a token the CLI reads anonymously. The outbox and journal are kept in `--state DIR` (the default is a temp dir).
- Tests (mock 18799, static 8798; need a codec: the local bundle or an embedded copy): `node tools/core_test.js` (31),
  `tools/run_e2e.sh tools/e2e_test.py` (48), `tools/run_e2e.sh tools/e2e_more_test.py` (23: conflict, codec, compaction, snapshot,
  page vs Node), `tools/run_e2e.sh tools/cli_e2e_test.py` (11), `tools/run_e2e.sh tools/e2e_codec_test.py` (19: `.bin` only,
  `?codec=json` ignored, no codec -> queued + error + nothing written, survives reload, drains as `.bin` once the codec loads, encode
  failure -> queued then `.bin`, legacy `.json` readable with and without codec, CLI `.bin` / `--codec json` refused / no codec -> exit 4
  with queued outbox, then flush as `.bin`).
