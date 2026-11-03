# atlas-sync-test

Public test host for the **Exp7 atlas sync experiment**.

Several static, single-file HTML clients (opened from `file://` or served over plain http, no backend of ours) edit a shared **atlas** using **only GitHub's REST API** (no git protocol, no CLI in the client).

**Multi-user design (2026-11-02):** nobody hands out tokens for someone else's account. Each writer has their **own public repo** `<their-login>/atlas-sync-log`, writes only there (with a fine-grained token from their own account), and **reads every other writer's repo without a token**. Fine-grained tokens can only write to repos owned by the token's own account, and adding someone as a collaborator does **not** change that. This repo (`MatthewGRodriguez/atlas-sync-test`) now hosts the client, mock and docs; it is no longer the write target.

An *atlas* is the Exp7 data format: a compact binary snapshot plus an append-only binary change log.
**Binary atlas/1 (`.bin`, `JRBA`) is the only format the client and CLI write** (segments, packs, snapshots; decision 2026-11-03, ADR 0113).
There is no JSON write path and no JSON fallback. Without the codec nothing is written: changes stay queued (op form, sessionStorage /
CLI outbox) with a visible "codec required to write" error, nothing is lost, and they are written as `.bin` once the codec is available.
Old `.json` segments from earlier tests remain **readable** (read-only legacy decoder).
The codec itself (the Artist's code) is not in this public repo; see `clients/README.md` for building/embedding it locally.

## Data policy (hard rule)

- **Only invented, synthetic data ever goes in this repo.** No real user data, no budget/financial data, no personal information.
- **No tokens, secrets, client secrets or credentials** are ever committed. Clients ask the user for credentials at runtime and must never write them into the repo.
- This repo is public: assume everything here is world-readable forever (git history included).

## Sign-in (honest note)

`clients/client.html` has a **Sign in with GitHub** button, but it only navigates the same tab to GitHub's prefilled *new fine-grained token* page (use the browser Back button to return). You generate a token there (only your own `atlas-sync-log` repo, Contents: Read and write, 30-day expiry) and paste it into the page. **Create my log repo** makes the repo for you (API if the token allows it, otherwise GitHub's prefilled new-repo page). **This is a pasted token, not an OAuth sign-in: GitHub offers no sign-in for a static page without a backend** (the OAuth endpoints need a client secret and/or send no CORS headers). There is no proxy of any kind. The token is held in tab memory (optionally `sessionStorage` via "Remember for this tab"), never `localStorage`, never shown or logged. Never paste a token into chat or commit it.

## Troubleshooting
- **"no write access" / Write refused (403)**: the token must come from the account that owns the repo it writes to (`<login>/atlas-sync-log`), with that repo under Repository access and Contents: Read and write. Being a collaborator on someone else's repo does not help with fine-grained tokens; write to your own repo instead and add theirs as a peer.
- Earlier versions of this README suggested adding the other account as a collaborator. That advice was wrong for fine-grained tokens and has been removed.

## Layout

- `atlas/` – atlas snapshot and log segments (synthetic only)
- `clients/` – static HTML test client (`client.html`)
- `tools/` – local GitHub mock, e2e tests, `inline_core.js`, `build_codec_bundle.sh`, `embed_codec.js`
- `log/<writer>/` – old segments from the single-shared-repo design (synthetic; no longer written)
- `docs/` – research and protocol notes, see `docs/rest-sync-notes.md`

## License

MIT, see `LICENSE`.
