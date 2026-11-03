# Test runbook: two clients, real GitHub (Matthew's Mac)

**Never paste a token, code or secret into chat.** The page never shows the token; the diagnostics box is safe to copy.

**Expected outcome:** sign-in will most likely be **blocked by CORS**. GitHub's device-flow endpoints (`github.com/login/device/code`, `/login/oauth/access_token`) sent no `Access-Control-Allow-Origin` header when tested with curl, so a browser page should not be able to read their answers. That failure is useful: the diagnostics box records it, and then we decide on a proxy.

## 1. Get the files (pick one)
- `git clone https://github.com/MatthewGRodriguez/atlas-sync-test.git`, or
- Open https://github.com/MatthewGRodriguez/atlas-sync-test, click **Code → Download ZIP**, and unzip it.

You do not need GitHub Pages. You open `clients/client.html` straight from disk (`file://`).

## 2. Register an OAuth App (one time)
1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Name: `atlas-sync-test`. Homepage URL: `http://localhost`. Callback URL: `http://localhost`.
3. Click **Register application**, then tick **Enable Device Flow** and save.
4. Copy **only the Client ID**. Do **not** generate a client secret. You don't need one, and it must never go anywhere.

## 3. Open two clients
In Chrome, open these two addresses in two tabs. Change the path to where you put the files, and replace `CLIENT_ID`:
```
file:///Users/<you>/atlas-sync-test/clients/client.html?writer=A&client_id=CLIENT_ID
file:///Users/<you>/atlas-sync-test/clients/client.html?writer=B&client_id=CLIENT_ID
```
The scope is already `public_repo`, which is enough for this public repo. Each writer writes only to `log/<writer>/`.

## 4. Sign in (tab A first)
Click **Sign in with GitHub**.
- **If it works:** a code like `ABCD-1234` appears and `github.com/login/device` opens. Enter the code there and approve. The header then shows **signed in as <your login>**. Repeat in tab B (approving twice is fine).
- **If it fails (likely):** the status shows an error, and **Sign-in diagnostics** says "BLOCKED… the block is CORS" or something similar. Click **Copy diagnostics** and paste that text into your report. Also try **Run CORS probe only** and copy again. Stop here; this is the evidence we need for the proxy decision.
- Optional: **Try web flow (diagnostic)** opens GitHub's normal sign-in page. It cannot finish, because swapping the code for a token needs the client secret, which a static page cannot hold. It only shows whether the redirect part works. If you try it, copy the diagnostics afterwards.

## 5. If signed in: sync test
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
- The copied **Sign-in diagnostics** text.
- Your browser and version, and whether you used `file://` or http.
- If writes failed: the error lines (for example 403 or 404 with their message).

## 7. Clean up
- Close both tabs (the token lives only in that tab) or click **Sign out**.
- Revoke the authorization: GitHub → **Settings → Applications → Authorized OAuth Apps → atlas-sync-test → Revoke**.
- Optional: delete the OAuth App under Developer settings → OAuth Apps.

## Local mock (no GitHub needed)
```
node tools/mock_github.js            # http://localhost:18799, device CORS on
node tools/mock_github.js --device-cors 0   # simulate GitHub's CORS block
```
Open `client.html?writer=A&api=http://localhost:18799&auth=http://localhost:18799&client_id=mock`. The automated test is `tools/e2e_test.py` (Playwright).
