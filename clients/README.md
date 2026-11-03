# clients/

`client.html`: a single-file test client (no backend, no proxy). Each writer:

- signs in with a pasted fine-grained personal access token from **their own** GitHub account (the button navigates the same tab to GitHub's prefilled token page; press Back to return and paste; GitHub offers no static-page sign-in without a backend). The token stays in tab memory (optionally sessionStorage), never localStorage, never logged;
- writes one segment per accepted batch to **their own public repo** `<login>/atlas-sync-log` at `log/<writerId>/<seq>.bin` (binary atlas/1, the primary format; `.json` in JSON debug mode or on fallback; writer id defaults to the GitHub login);
- reads every peer repo listed in **Peers** (`owner/repo`, comma/newline separated; also `?peers=`), anonymously if not signed in;
- merges all segments in a deterministic order (writer timestamp, writer id, seq), last write wins; see `../docs/rest-sync-notes.md`.

**Create my log repo**: if signed in, tries `POST /user/repos` (needs a token with Administration: write); if that is refused or you are not signed in, opens `https://github.com/new?name=atlas-sync-log&visibility=public&description=Atlas%20sync%20log` in the same tab, and detects the repo when you come back. An existing repo is simply used.

Fine-grained tokens can only write to repos owned by the token's account; collaborator access does not help. Codec hooks: `encodeSegment/decodeSegment/encodeSnapshot/decodeSnapshot` (binary default, JSON debug/fallback; readers accept both). See `../docs/test-runbook.md`.

## Exp7 additions (doc 47)
- `exp7-sync-core.js`: shared core (replay, op rules, LWW order `[ts, writer, seq, repo]`, codec hooks, packs, snapshots).
  It is inlined into `client.html` between the `EXP7-CORE` markers, so the page stays a single file. After you edit it, run
  `node tools/inline_core.js`. Use `--check` in CI.
- **Binary atlas/1 is the primary (default) write format** for segments, packs and snapshots (`.bin`, `JRBA` magic). JSON stays the
  interchange/debug form and is always readable: tick **Write JSON (debug)** or open the page with `?codec=json` to write `.json`.
  Readers accept a mix of `.json` and `.bin` and replay it to the identical state.
- Where the codec comes from (no backend, no proxy): (1) a copy embedded in `client.html` between the `ATLAS-CODEC` markers
  (`node tools/embed_codec.js` after `tools/build_codec_bundle.sh <codec dir>`; the page becomes ~590 KB, still one file), else
  (2) `atlas_codec.bundle.js` next to the page (or `?codecsrc=URL`), loaded once at startup. The codec is the Artist's code, so the
  **public repo ships the markers empty** (`node tools/embed_codec.js --strip` before committing) and the bundle stays gitignored.
- Changes never fail because of the codec: if it is missing, fails to load (`?nocodec=1` simulates this) or an encode throws, that batch
  is written as `.json`, a red warning appears next to the checkbox and in the error log, and nothing is dropped or left queued.
  Writes wait for the startup codec load, so the default really is binary when a codec is available. A reader without a codec reports
  `.bin` segments it cannot decode and skips them (no guessing).
- **Compact mine** packs my own contiguous segments into `log/<me>/pack-<first>-<last>.<ext>` in one fast-forward Git Data
  commit. Packs stay under 256 KB soft and 1 MB hard, and nothing is ever split. Compaction is manual only.
- **Publish snapshot** writes `snapshots/<me>/snap-N`. This is a cache. Readers use it only with `?usesnap=1` and drop it if a late
  segment sorts inside it.
- `atlas-cli.js` (Node 18+): `status | read [prefix] | watch | propose '<ops json>' | flush | digest`. The token comes from env
  `ATLAS_TOKEN` only. It writes `.bin` by default (`--codec json` for JSON) using the codec embedded in `client.html`, else
  `clients/atlas_codec.bundle.js`; without one it writes `.json` with a warning on stderr (`ATLAS_NO_CODEC=1` simulates that). Without a token the CLI reads anonymously. The outbox and journal are kept in `--state DIR` (the default is a temp dir).
- Tests (mock 18799, static 8798; need a codec: the local bundle or an embedded copy): `node tools/core_test.js` (28),
  `tools/run_e2e.sh tools/e2e_test.py` (48), `tools/run_e2e.sh tools/e2e_more_test.py` (23: conflict, codec, compaction, snapshot,
  page vs Node), `tools/run_e2e.sh tools/cli_e2e_test.py` (11), `tools/run_e2e.sh tools/e2e_codec_test.py` (17: default `.bin`,
  `?codec=json`, mixed log -> identical state, codec-load and encode failure -> JSON fallback without loss, CLI default/json/fallback).
