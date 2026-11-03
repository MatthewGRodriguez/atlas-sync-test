# Test runbook: two writers, two real GitHub accounts

**You need two real GitHub accounts:** Matthew's and a second tester's. Each person uses a token from **their own** account only. Never send a token to anyone, never paste one into chat, a file, or a commit. The page never shows the token; the diagnostics box masks it and is safe to copy.

**Why one repo each:** a fine-grained token can only write to repos owned by the token's own account. Adding the other person as a collaborator does **not** change that (earlier docs said it would; that was wrong). So each person writes to `<their-login>/atlas-sync-log` and reads the other person's repo, which is public and needs no token.

**How sign-in works:** you create a fine-grained personal access token on GitHub and paste it into the page. This is a pasted token, not an OAuth sign-in: GitHub offers no sign-in for a static page without a backend, and there is no proxy. Everything is inside `clients/client.html`.

## 1. Get the file
`git clone https://github.com/MatthewGRodriguez/atlas-sync-test.git` or **Code → Download ZIP**. Open `clients/client.html` straight from disk (`file://`) in Chrome. No GitHub Pages needed. Each person does this on their own computer, or in two separate Chrome profiles (one per account) on one Mac.

## 2. Create your log repo (each person, once)
1. Click **Create my log repo**.
   - Not signed in yet (usual case): the tab goes to GitHub's *new repository* page prefilled with name `atlas-sync-log`, **Public**, description "Atlas sync log". Make sure you are signed in to GitHub as **yourself**, click **Create repository**, then press the browser **Back** button. A README is optional; an empty repo works.
   - Already signed in with a token that has Administration: write: the page creates the public repo directly through the API.
   - If the repo already exists, the page just uses it.
2. After sign-in (step 3), the page shows "my repo `<login>/atlas-sync-log`: exists, public, write access confirmed". **Check my repo again** re-checks.

## 3. Create a token and connect (each person)
1. Click **Sign in with GitHub**. GitHub's *New fine-grained personal access token* page opens in the same tab, prefilled with name "Atlas sync", 30-day expiry and Contents: Read and write.
2. **Resource owner**: yourself. **Repository access** → **Only select repositories** → `<your-login>/atlas-sync-log`.
   (Only if you ticked "token may also create my repo" and the repo does not exist yet: the token URL also asks for Administration: write and you must pick **All repositories**, because a repo that does not exist cannot be selected. That is a broad token; the github.com/new path in step 2 avoids it.)
3. **Generate token**, copy it, press **Back**, paste it into **Token**, click **Connect**. Tick **Remember for this tab** first if you want it to survive a reload (sessionStorage only).
4. Expected: "Signed in as `<login>`; my repo `<login>/atlas-sync-log`: exists, public, write access confirmed." The writer id becomes your login.
5. Possible messages:
   - "rejected this token (401)": wrong, expired, or revoked token.
   - "does not exist yet": click **Create my log repo**.
   - "WARNING: GitHub reports no write access": the token's Repository access does not include your repo, or Contents is read-only. Fix the token (Settings → Developer settings → Fine-grained tokens → edit).
   - "is PRIVATE": the other person cannot read it. Make it public.
   - "Write refused (403)": the first write was rejected; the batch stays queued.

## 4. Add each other as peers
1. Click **Copy** next to "My repo" and send that short string (e.g. `MatthewGRodriguez/atlas-sync-log`) to the other person. It is not a secret. **Copy share link** gives a link with `?peers=` already filled in.
2. Paste the other person's string into **Peers** (comma or newline separated).

## 5. Sync test
Click **Start sync** on both sides (poll every 10 s when signed in; adjustable).
1. Matthew changes Harbor walk's joy to 9. Within about 10–20 s the tester sees 9.
2. Tester changes it to 6. Matthew sees 6 and a red **CHANGED … (yours) … by `<tester>`** line.
3. Both press **+1** on the same item at about the same time. Both end at 8 (deltas add up).
4. **Send empty batch**: a new commit in your own repo, no error.
5. Add the same note on both sides: the rev for `items/i1/notes` does not go up the second time.
6. Pick another place to sleep and move the date: shows up on the other side.
7. Reload one tab: the state is rebuilt from both repos and matches.
8. Optional: open the page signed out with `?peers=<matthew>/atlas-sync-log,<tester>/atlas-sync-log`: it shows the same state read anonymously (polls slowly, about 72 s per repo, because anonymous access is 60 requests/hour).

Each repo should only contain commits `atlas:demo writer:<its owner> seq:N` with files under `log/<owner>/`.

## 6. What to report if anything fails
- Screenshot of **Status**, **Repos read** and **Event log**.
- The copied **Sign-in diagnostics** text (token masked). **Run API probe** checks that api.github.com is reachable.
- Browser and version, `file://` or http.

## 7. Clean up
- **Sign out** (clears memory and sessionStorage, stops polling) or close the tab.
- Delete the token: GitHub → Settings → Developer settings → Fine-grained tokens → Atlas sync → Delete (it also expires after 30 days).
- Optionally delete your `atlas-sync-log` repo (Settings → Danger Zone). It holds synthetic data only.

## Local mock (no GitHub needed)
```
node tools/mock_github.js                         # http://localhost:18799, multi-account
python3 -m http.server 8798 --bind 127.0.0.1      # from repo root, for the http:// check
python3 tools/e2e_test.py                         # Playwright + one headless Chrome
# or all, each on a fresh mock (needs clients/atlas_codec.bundle.js or an embedded codec, since binary is the only write format):
node tools/core_test.js                           # 31
for t in e2e_test e2e_more_test cli_e2e_test e2e_codec_test; do tools/run_e2e.sh tools/$t.py; done   # 48, 23, 11, 19
```
Open `client.html?api=http://localhost:18799&peers=bob/atlas-sync-log` and paste a synthetic mock token:
`test-valid-<login>[-anything]` (login `<login>`, writes only to repos it owns, can create repos), `test-readonly-<login>` (no write); anything else gets 401; no token = anonymous reads of public repos.
Knobs: `/__mock/mkrepo?full=bob/atlas-sync-log&init=0` (empty repo), `/__mock/config?createForbidden=1` (POST /user/repos → 403), `?revoke=<token>|none`, `?fail403=N&failPut409=N`; `/__mock/state`. Client param `anonmin=<s>` overrides the anonymous per-repo poll floor (tests only). Never use ports 8765 or 8791.

## 8. Optional Exp7 checks on real GitHub (prepared, NOT run yet)
Run these only with two real accounts, after steps 1–5 pass.
1. **Conflict**: both people edit the same value (for example Harbor walk joy) within about 5 s, then wait for 2 polls. Both pages must show
   the same value. The loser sees an "overwrote" line, and the winner sees "changed … from <other>".
2. **Binary codec (default)**: with `atlas_codec.bundle.js` next to `client.html` (shared privately; or a privately embedded page),
   make one edit. The repo shows `log/<you>/<seq>.bin`, and the other page converges. Without the codec the page shows **Codec required to write**,
   the edit stays queued (nothing appears in the repo, nothing lost, a reload keeps it); put the codec back and press **Retry codec**:
   the edit lands as `.bin`. There is no JSON write option any more; old `.json` segments are still read.
3. **Compaction**: after 5 or more edits, click **Compact mine**. There is one new commit "… compact a-b", the singles disappear,
   and the other page plus a private window (no token) show the same state.
4. **Snapshot**: click **Publish snapshot**, then open the page with `?usesnap=1` in a private window. It shows the same state.
5. **CLI**: `ATLAS_TOKEN=<token> node clients/atlas-cli.js status` (type the token in the shell only, never into a file).
   Then run `node clients/atlas-cli.js propose '[{"op":"delta","path":"joys/i1/value","by":1}]'`. The page shows it after one poll.
