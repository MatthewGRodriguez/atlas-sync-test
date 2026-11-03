# Test runbook: two clients, real GitHub (Matthew's Mac)

**Never paste a token into chat, a file, or a commit.** The page never shows the token; the diagnostics box masks it and is safe to copy.

**How sign-in works:** you create a fine-grained personal access token on GitHub and paste it into the page. This is a pasted token, not an OAuth sign-in: GitHub offers no sign-in for a static page without a backend, and we use no proxy. Everything is inside `clients/client.html`.

## 1. Get the files (pick one)
- `git clone https://github.com/MatthewGRodriguez/atlas-sync-test.git`, or
- Open https://github.com/MatthewGRodriguez/atlas-sync-test, click **Code → Download ZIP**, and unzip it.

You do not need GitHub Pages. Open `clients/client.html` straight from disk (`file://`).

## 2. Open two clients
In Chrome, open these two addresses in two tabs (change the path to where you put the files):
```
file:///Users/<you>/atlas-sync-test/clients/client.html?writer=A
file:///Users/<you>/atlas-sync-test/clients/client.html?writer=B
```
Each writer writes only to `log/<writer>/`.

## 3. Create a token (one time, about 1 minute)
1. In tab A click **Sign in with GitHub**. GitHub's *New fine-grained personal access token* page opens in the same tab, prefilled with name "Atlas sync", 30-day expiry and Contents: Read and write.
2. Under **Repository access** pick **Only select repositories** → `MatthewGRodriguez/atlas-sync-test`.
3. Under **Permissions** confirm **Contents: Read and write**.
4. Click **Generate token** and copy it.
5. Press the browser **Back** button to return to tab A (its settings and pre-sign-in state are restored from sessionStorage; no token is stored at this point).

## 4. Connect (both tabs)
1. Paste the token into the **Token** field and click **Connect**. Tick **Remember for this tab** first if you want it to survive a reload of that tab (sessionStorage only; it is never saved to localStorage).
2. Expected: "Signed in as <your login>; … write access confirmed." The header shows **signed in as <login>**.
3. Possible messages:
   - "rejected this token (401)": wrong, expired, or revoked token.
   - "cannot see MatthewGRodriguez/atlas-sync-test": the repo was not selected under Repository access.
   - "WARNING: GitHub reports no write access": the page still connects, but writes will be refused. Check Contents: Read and write on the token, and see the next item.
   - "Token belongs to GitHub account X, not the repo owner" (wrong account / not a collaborator): the token was made on a different GitHub account. A public repo is readable by any token, so GET /user and the repo check both return 200, but writing needs that account to be a collaborator with write access (Settings → Collaborators on the repo, then accept the invite), or create the token while signed in as the repo owner. Sign-in diagnostics log the login and the raw `permissions` object.
   - "Write refused (403)": first write was rejected; the batch stays queued and is retried after you fix access and reconnect.
4. Paste the same token in tab B and click **Connect** (one token for both tabs is fine).

If a token expires or is revoked during the test, the page signs out on the next 401 and says so.

## 5. Sync test
Click **Start sync** in both tabs (polls every 7 s).
1. In A, change Harbor walk's joy to 9. Within about 10 s, B should show 9.
2. In B, change the same joy to 6. A should show 6, plus a red **CHANGED … (yours) … by B** line.
3. In A press **+1** and in B press **+1** on the same item at about the same time. Both should end at 8 (6 + 1 + 1; deltas add up).
4. Click **Send empty batch** in A. A new commit should appear with no error.
5. Add the same note in A and then in B. In the Revisions panel, the rev for `items/i1/notes` should not go up the second time.
6. Pick another place to sleep and move the date. It should show up in the other tab.

Check that the repo got commits `atlas:demo writer:A seq:N` with files under `log/A/` and `log/B/`.

## 6. What to report if anything fails
- Screenshot of the **Status** panel and the **Event log**.
- The copied **Sign-in diagnostics** text (token is masked). **Run API probe** checks that api.github.com is reachable.
- Your browser and version, and whether you used `file://` or http.
- If writes failed: the error lines (for example 403 or 404 with their message).

## 7. Clean up
- Click **Sign out** in both tabs (clears memory and sessionStorage, stops polling) or close them.
- Revoke the token: GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Atlas sync → Delete**. (It also expires on its own after 30 days.)

## Local mock (no GitHub needed)
```
node tools/mock_github.js                         # http://localhost:18799
python3 -m http.server 8798 --bind 127.0.0.1      # from repo root, for the http:// check
python3 tools/e2e_test.py                         # Playwright + Chrome
```
Open `client.html?writer=A&api=http://localhost:18799` and paste a synthetic mock token:
`test-valid-<name>` (works), `test-readonly-<name>` (no write), `test-norepo-<name>` (repo not selected); anything else gets 401.
Revoke mid-session with `http://localhost:18799/__mock/config?revoke=<token>` (`revoke=none` resets). Never use ports 8765 or 8791.
