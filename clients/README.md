# clients/

`client.html`: a single-file test client (no backend, no proxy). Each writer:

- signs in with a pasted fine-grained personal access token from **their own** GitHub account (the button navigates the same tab to GitHub's prefilled token page; press Back to return and paste; GitHub offers no static-page sign-in without a backend). The token stays in tab memory (optionally sessionStorage), never localStorage, never logged;
- writes one segment per accepted batch to **their own public repo** `<login>/atlas-sync-log` at `log/<writerId>/<seq>.json` (writer id defaults to the GitHub login);
- reads every peer repo listed in **Peers** (`owner/repo`, comma/newline separated; also `?peers=`), anonymously if not signed in;
- merges all segments in a deterministic order (writer timestamp, writer id, seq), last write wins; see `../docs/rest-sync-notes.md`.

**Create my log repo**: if signed in, tries `POST /user/repos` (needs a token with Administration: write); if that is refused or you are not signed in, opens `https://github.com/new?name=atlas-sync-log&visibility=public&description=Atlas%20sync%20log` in the same tab, and detects the repo when you come back. An existing repo is simply used.

Fine-grained tokens can only write to repos owned by the token's account; collaborator access does not help. Codec hooks: `encodeSegment/decodeSegment/encodeSnapshot/decodeSnapshot` (JSON default). See `../docs/test-runbook.md`.
