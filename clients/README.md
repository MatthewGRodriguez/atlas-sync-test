# clients/

`client.html`: a single-file test client (no backend, no proxy). Each writer:

- signs in with a pasted fine-grained personal access token from **their own** GitHub account (the button navigates the same tab to GitHub's prefilled token page; press Back to return and paste; GitHub offers no static-page sign-in without a backend). The token stays in tab memory (optionally sessionStorage), never localStorage, never logged;
- writes one segment per accepted batch to **their own public repo** `<login>/atlas-sync-log` at `log/<writerId>/<seq>.json` (writer id defaults to the GitHub login);
- reads every peer repo listed in **Peers** (`owner/repo`, comma/newline separated; also `?peers=`), anonymously if not signed in;
- merges all segments in a deterministic order (writer timestamp, writer id, seq), last write wins; see `../docs/rest-sync-notes.md`.

**Create my log repo**: if signed in, tries `POST /user/repos` (needs a token with Administration: write); if that is refused or you are not signed in, opens `https://github.com/new?name=atlas-sync-log&visibility=public&description=Atlas%20sync%20log` in the same tab, and detects the repo when you come back. An existing repo is simply used.

Fine-grained tokens can only write to repos owned by the token's account; collaborator access does not help. Codec hooks: `encodeSegment/decodeSegment/encodeSnapshot/decodeSnapshot` (JSON default). See `../docs/test-runbook.md`.

## Exp7 additions (doc 47)
- `exp7-sync-core.js`: shared core (replay, op rules, LWW order `[ts, writer, seq, repo]`, codec hooks, packs, snapshots).
  It is inlined into `client.html` between the `EXP7-CORE` markers, so the page stays a single file. After you edit it, run
  `node tools/inline_core.js`. Use `--check` in CI.
- Binary codec (opt-in, JSON is the default): tick **Binary segments** or open the page with `?codec=bin`. The page then loads
  `atlas_codec.bundle.js`, which is the Artist's codec. You build it locally with `tools/build_codec_bundle.sh`. It is **not committed**.
  Readers load it automatically when they meet a `.bin` segment. Without it they show an error and skip that segment.
- **Compact mine** packs my own contiguous segments into `log/<me>/pack-<first>-<last>.<ext>` in one fast-forward Git Data
  commit. Packs stay under 256 KB soft and 1 MB hard, and nothing is ever split. Compaction is manual only.
- **Publish snapshot** writes `snapshots/<me>/snap-N`. This is a cache. Readers use it only with `?usesnap=1` and drop it if a late
  segment sorts inside it.
- `atlas-cli.js` (Node 18+): `status | read [prefix] | watch | propose '<ops json>' | flush | digest`. The token comes from env
  `ATLAS_TOKEN` only. Without a token the CLI reads anonymously. The outbox and journal are kept in `--state DIR` (the default is a temp dir).
- Tests (mock 18799, static 8798): `node tools/core_test.js` (25), `tools/run_e2e.sh tools/e2e_test.py` (48),
  `tools/run_e2e.sh tools/e2e_more_test.py` (23: conflict, codec, compaction, snapshot, page vs Node),
  `tools/run_e2e.sh tools/cli_e2e_test.py` (11).
