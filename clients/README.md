# clients/

`client.html`: a single-file test client used by every writer (`?writer=A`, `?writer=B`). It signs in with the GitHub OAuth device flow (client ID only, never a secret), keeps the token only in the tab, writes one log segment per accepted batch to `log/<writer>/<seq>.json`, and polls `main` for the other writers' segments. Codec hooks: `encodeSegment/decodeSegment/encodeSnapshot/decodeSnapshot`. See `../docs/test-runbook.md`.
