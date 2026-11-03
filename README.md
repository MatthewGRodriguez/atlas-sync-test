# atlas-sync-test

Public test host for the **Exp7 atlas sync experiment**.

Several static, single-file HTML clients (opened from `file://` or served over plain http, no backend of ours) sign in with GitHub and edit an **atlas** stored in this repo, using **only GitHub's REST API** (no git protocol, no CLI in the client). Another client reads those changes and writes back.

An *atlas* is the Exp7 data format: a compact binary snapshot plus an append-only binary change log, with JSON as a debug form.

## Data policy (hard rule)

- **Only invented, synthetic data ever goes in this repo.** No real user data, no budget/financial data, no personal information.
- **No tokens, secrets, client secrets or credentials** are ever committed. Clients ask the user for credentials at runtime and must never write them into the repo.
- This repo is public: assume everything here is world-readable forever (git history included).

## Layout

- `atlas/` – atlas snapshot and log segments (synthetic only)
- `clients/` – static HTML test client (`client.html`)
- `tools/` – local GitHub mock + e2e test
- `log/<writer>/` – log segments written by clients (synthetic)
- `docs/` – research and protocol notes, see `docs/rest-sync-notes.md`

## License

MIT, see `LICENSE`.
