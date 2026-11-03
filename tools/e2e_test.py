# E2E test for clients/client.html (multi-account, one public log repo per writer) against tools/mock_github.js.
# Start first (from repo root):  node tools/mock_github.js &   python3 -m http.server 8798 --bind 127.0.0.1 &
# Ports 18799 (mock) and 8798 (static) only. All tokens below are SYNTHETIC strings understood only by the mock.
import json, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
M='http://localhost:18799'
def get(path): return json.load(urllib.request.urlopen(M+path))
def cfg(q): return get('/__mock/config?'+q)
FILE='file:///workspace/atlas-sync-test/clients/client.html'
def url(base, peers, extra=''): return f'{base}?api={M}&poll=2&autostart=1&peers={peers}{extra}'
def paste(pg, tok, remember=True):
    pg.fill('#fToken', tok)
    if remember != pg.is_checked('#fRemember'): pg.click('#fRemember')
    pg.click('#bConnect')
def msg(pg, el='authMsg'): return pg.evaluate(f"document.getElementById('{el}').textContent")
res=[]; errors=[]
def check(name, ok, info=''):
    res.append((name, bool(ok))); print(('PASS' if ok else 'FAIL'), name, '' if ok else info, flush=True)
def until(pg, js, t=25):
    end=time.time()+t
    while time.time()<end:
        try:
            if pg.evaluate(js): return True
        except Exception: pass
        time.sleep(0.3)
    return False
def watch(pg, n):
    pg.on('pageerror', lambda e: errors.append(f'{n}: {e}'))
    pg.on('console', lambda m: m.type=='error' and errors.append(f'{n} console: {m.text}'))
ALICE='alice/atlas-sync-log'; BOB='bob/atlas-sync-log'
get('/__mock/mkrepo?full=bob/atlas-sync-log&init=0')     # bob's repo exists but is EMPTY (no branch): first PUT must create main
get('/__mock/mkrepo?full=carol/atlas-sync-log&init=1')
TA='test-valid-alice-e2e'; TB='test-valid-bob-e2e'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--disable-gpu','--no-sandbox'])
    ctx=b.new_context()
    A=ctx.new_page(); watch(A,'alice'); A.goto(url(FILE,BOB))
    B=ctx.new_page(); watch(B,'bob'); B.goto(url(FILE,ALICE))
    check('parses from file:// (script ran)', A.evaluate("typeof applyOp==='function' && location.protocol==='file:'"))
    check('peers from ?peers= shown and kept in sessionStorage', A.evaluate(f"A.peers.join()==='{BOB}' && sessionStorage.getItem('atlasSyncPeers')==='{BOB}'"))
    hits=[]
    def gh(r): hits.append(r.request.url); r.fulfill(status=200, content_type='text/html', body='<title>mock github</title>mock github page')
    ctx.route('https://github.com/**', gh)
    PAT='https://github.com/settings/personal-access-tokens/new?name=Atlas%20sync&description=Static%20page%20access&expires_in=30&contents=write'
    NEW='https://github.com/new?name=atlas-sync-log&visibility=public&description=Atlas%20sync%20log'
    A.click('#fRemember'); npages=len(ctx.pages); start_url=A.url
    with A.expect_navigation(url=PAT): A.click("#bSignIn")
    check('Sign in navigates same tab to exact prefilled PAT URL (contents=write only)', A.url==PAT and hits==[PAT] and len(ctx.pages)==npages, (A.url, hits))
    A.go_back(); A.wait_for_load_state()
    check('Back returns with pre-sign-in state + note', A.url==start_url and until(A,f"document.getElementById('returnNote').style.display!=='none' && document.getElementById('fRemember').checked && A.peers.join()==='{BOB}' && A.token===null && localStorage.length===0"), A.url)
    A.reload(); A.wait_for_load_state()
    check('reload after return still restores pre-sign-in state', until(A,"document.getElementById('returnNote').style.display!=='none' && document.getElementById('fRemember').checked && typeof applyOp==='function'"))
    A.click('#fCreatePerm')
    check('create option adds &administration=write to token URL', A.evaluate("patUrl()")==PAT+'&administration=write')
    A.click('#fCreatePerm')
    # Create my log repo while NOT signed in -> prefilled github.com/new in the same tab, Back restores
    hits.clear()
    with A.expect_navigation(url=NEW): A.click("#bCreateRepo")
    check('Create repo (signed out) opens exact prefilled github.com/new in same tab', A.url==NEW and hits==[NEW], (A.url, hits))
    A.go_back(); A.wait_for_load_state()
    check('Back from new-repo page restores state + guidance', until(A,"document.getElementById('returnNote').textContent.includes('sign in') && document.getElementById('fRemember').checked"), msg(A,'returnNote'))
    A.click('#fRemember')  # unchecked for following checks
    check('token input is password type', A.evaluate("document.getElementById('fToken').type==='password'"))
    paste(A,'not-a-real-token')
    check('bad token rejected (401)', until(A,"document.getElementById('authMsg').textContent.includes('401')") and A.evaluate("A.token===null && !sessionStorage.getItem('atlasSyncToken')"), msg(A))
    # readonly token on own existing repo -> warning; first write refused; NO collaborator advice
    R=ctx.new_page(); watch(R,'carol'); R.goto(url(FILE,BOB)); paste(R,'test-readonly-carol')
    check('readonly token connects with visible warning', until(R,"A.login==='carol' && A.ownRepo==='carol/atlas-sync-log' && document.getElementById('authMsg').className==='warn' && document.getElementById('authMsg').textContent.includes('WARNING')"), msg(R))
    check('raw permissions logged in diagnostics', R.evaluate("[...document.querySelectorAll('#diag div')].some(e=>e.textContent.includes('permissions admin=false, maintain=false, push=false'))"))
    until(R,'A.synced'); R.evaluate("propose([{op:'set',path:'joys/i3/value',value:4}])")
    check('readonly: write refused clearly (own-account rule, no collaborator fix), batch stays queued', until(R,"A.errors.some(e=>e.includes('Write refused (403)') && e.includes('collaborator does not help')) && A.pending.length===1 && A.pending[0].state==='queued'") and not R.evaluate("document.body.innerText.includes('add') && /add(ed)? as a collaborator|must be a collaborator/.test(document.body.innerText)"), R.evaluate('A.errors'))
    R.close()
    # cross-account write is refused by the mock exactly like GitHub (alice token -> bob's repo)
    rq=urllib.request.Request(M+'/repos/bob/atlas-sync-log/contents/log/alice/000001.json', method='PUT', data=json.dumps({'message':'x','content':'e30='}).encode(), headers={'Authorization':'Bearer '+TA,'Content-Type':'application/json'})
    try: urllib.request.urlopen(rq); code=200
    except urllib.error.HTTPError as e: code=e.code
    check('a token cannot write to another account\'s repo (403)', code==403, code)
    # alice signs in: repo does not exist yet -> Create my log repo via API (POST /user/repos)
    paste(A, TA, remember=True)
    check('alice sign-in: login -> own repo alice/atlas-sync-log, writer id defaults to login, repo missing noted', until(A,"A.login==='alice' && A.writer==='alice' && A.ownRepo==='alice/atlas-sync-log' && A.ownExists===false && document.getElementById('repoMsg').textContent.includes('does not exist')"), msg(A))
    A.click('#bCreateRepo')
    check('Create my log repo via API: created public + auto_init, then used', until(A,"A.ownExists===true && A.ownPush===true && [...document.querySelectorAll('#evlog div')].some(e=>e.textContent.includes('created alice/atlas-sync-log'))") and get('/__mock/state')[ALICE]['private']==False, msg(A,'repoMsg'))
    A.click('#bCreateRepo')
    check('Create again when repo exists: just uses it', until(A,"document.getElementById('repoMsg').textContent.includes('already exists; using it')"))
    check('share string = own repo, share link has peers', A.evaluate("document.getElementById('myRepo').textContent")==ALICE and ('peers=alice%2Fatlas-sync-log%2Cbob%2Fatlas-sync-log' in A.evaluate('shareLink()')), A.evaluate('shareLink()'))
    # API create forbidden -> falls back to prefilled github.com/new (same tab), page detects the repo after Back
    D=ctx.new_page(); watch(D,'dave'); D.goto(url(FILE,ALICE)); paste(D,'test-valid-dave', remember=True); until(D,"A.ownExists===false")
    cfg('createForbidden=1'); hits.clear()
    with D.expect_navigation(url=NEW): D.click('#bCreateRepo')
    check('API create refused (403) -> same-tab prefilled github.com/new', D.url==NEW and hits==[NEW], (D.url, hits))
    get('/__mock/mkrepo?full=dave/atlas-sync-log&init=0'); cfg('createForbidden=0')
    D.go_back(); D.wait_for_load_state()
    check('after Back the page detects the newly created repo', until(D,"A.login==='dave' && A.ownExists===true && document.getElementById('returnNote').style.display==='none'"), msg(D,'repoMsg'))
    D.close()
    paste(B, TB, remember=False)
    check('bob sign-in (memory only), own repo exists but empty', until(B,"A.login==='bob' && A.ownExists===true && A.synced"))
    check('return note cleared after sign-in', A.evaluate("document.getElementById('returnNote').style.display==='none' && !sessionStorage.getItem('atlasSyncSignInPending')"))
    check('token never in localStorage; alice remembered in sessionStorage, bob memory only', A.evaluate("localStorage.length===0 && !!sessionStorage.getItem('atlasSyncToken')") and B.evaluate("localStorage.length===0 && !sessionStorage.getItem('atlasSyncToken')"))
    check('token not shown in page or diagnostics', all(not pg.evaluate("document.body.innerText.includes('test-valid-') || document.documentElement.outerHTML.includes('test-valid-')") and pg.evaluate("document.getElementById('fToken').value===''") for pg in (A,B)))
    until(A,'A.synced')
    # 1 alice changes -> bob sees (bob reads alice's repo)
    A.fill('[data-joy=i2]','9'); A.dispatch_event('[data-joy=i2]','change')
    check('bob sees alice set joys/i2=9 (read from alice repo)', until(B,"A.view.v['joys/i2/value']===9"))
    st=get('/__mock/state')
    check('alice wrote only to her own repo; bob\'s repo still empty', all(c['files'][0].startswith('log/alice/') for c in st[ALICE]['commits'][1:]) and len(st[BOB]['commits'])==0)
    # 2 bob overwrites same path (later ts) -> alice converges + CHANGED
    B.fill('[data-joy=i2]','7'); B.dispatch_event('[data-joy=i2]','change')
    until(B,"A.pending.length===0"); bc=get('/__mock/state')[BOB]['commits']
    check('first PUT on an empty repo creates main', len(bc)>=1 and bc[0]['files']==['log/bob/000001.json'], bc)
    check('alice converges to bob value 7 (LWW by ts)', until(A,"A.view.v['joys/i2/value']===7 && A.view.rev['joys/i2/value'].owner==='bob'"))
    check('alice got CHANGED event', until(A,"[...document.querySelectorAll('.ev-changed')].some(e=>e.textContent.includes('joys/i2/value') && e.textContent.includes('bob'))"))
    # 3 concurrent deltas add up: seed 3 +2 +3 = 8
    A.evaluate("propose([{op:'delta',path:'joys/i1/value',by:2}])"); B.evaluate("propose([{op:'delta',path:'joys/i1/value',by:3}])")
    ok=until(A,"A.view.v['joys/i1/value']===8 && A.pending.length===0",30) and until(B,"A.view.v['joys/i1/value']===8 && A.pending.length===0",30)
    check('concurrent deltas add up to 8 on both', ok, (A.evaluate("A.view.v['joys/i1/value']"), B.evaluate("A.view.v['joys/i1/value']")))
    n=A.evaluate('A.nextSeq'); A.click('#bEmpty')
    check('empty batch written', until(A,f"A.nextSeq==={n+1} && A.pending.length===0"))
    # 5 no-op add keeps revision
    A.evaluate("propose([{op:'add',path:'items/i1/notes',value:'bring hat'}])")
    until(B,"(A.view.v['items/i1/notes']||[]).includes('bring hat')")
    r0=B.evaluate("A.view.rev['items/i1/notes'].rev")
    B.evaluate("propose([{op:'add',path:'items/i1/notes',value:'bring hat'}])")
    until(B,"A.pending.length===0"); until(A,"A.pending.length===0"); time.sleep(3)
    check('no-op add leaves revision unchanged', B.evaluate("A.view.rev['items/i1/notes'].rev")==r0==A.evaluate("A.view.rev['items/i1/notes'].rev") and A.evaluate("A.view.rev['items/i1/notes'].owner")=='alice', r0)
    A.evaluate("propose([{op:'add',path:'joys/i3/value',value:1}])")
    check('add on existing scalar rejected (exists)', until(A,"[...document.querySelectorAll('#evlog div')].some(e=>e.textContent.includes('rejected (exists)'))"))
    A.evaluate("propose([{op:'remove',path:'items/i9/notes',value:'zzz'},{op:'remove',path:'items/i2/notes',value:'buy day pass'}])")
    check('remove member propagates; remove missing no-op', until(B,"(A.view.v['items/i2/notes']||[]).length===0 && !('items/i9/notes' in A.view.rev)"))
    B.check('[data-pick=o2]'); B.fill('#dateIn','2026-12-05'); B.dispatch_event('#dateIn','change')
    check('ref pick + date move reach alice', until(A,"A.view.v['alts/g1/pick']==='o2' && A.view.v['dates/start/value']==='2026-12-05'"))
    cfg('fail403=1&failPut409=1')
    A.evaluate("propose([{op:'set',path:'alts/g1/opts/o3/unavail',value:false}])")
    check('403 retry-after + 409 retry then success', until(B,"A.view.v['alts/g1/opts/o3/unavail']===false",40) and A.evaluate("A.errors.some(e=>e.includes('limit hit'))"))
    st=get('/__mock/state')
    check('each writer wrote only log/<self>/ in its own repo', all(c['files'][0].startswith('log/alice/') for c in st[ALICE]['commits'][1:]) and all(c['files'][0].startswith('log/bob/') for c in st[BOB]['commits']), {k:len(v['commits']) for k,v in st.items()})
    check('poll shows 304 for both repos and rate remaining', until(A,f"A.repos.get('{ALICE}').status==='304' && A.repos.get('{BOB}').status==='304' && A.rate!=='-'"))
    vA=A.evaluate('JSON.stringify(A.view.v)')
    # anonymous reader (no token) reads both public repos
    V=ctx.new_page(); watch(V,'viewer'); V.goto(url(FILE, ALICE+','+BOB, '&anonmin=1'))
    check('anonymous reader rebuilds identical state from both public repos', until(V,f"A.token===null && A.synced && JSON.stringify(A.view.v)==={json.dumps(vA)}"))
    check('anonymous: limit 60 shown, poll interval floor applied, 304 polling', until(V,"A.rateLimit==='60' && effectivePollSec()>=2 && [...A.repos.values()].every(r=>r.status==='304')",30), V.evaluate("[A.rateLimit, effectivePollSec(), [...A.repos.values()].map(r=>r.status)]"))
    check('anonymous default floor = 72 s per repo', V.evaluate("(()=>{const s=A.anonMinPerRepo; A.anonMinPerRepo=72; const v=effectivePollSec(); A.anonMinPerRepo=s; return v;})()")==144)
    V.close()
    # reload bob (memory-only) -> rebuild from both repos
    B.reload(); paste(B, TB, remember=False); until(B,'A.login')
    check('fresh reload of bob rebuilds identical state (offline/reload rebuild)', until(B,f"A.synced && JSON.stringify(A.view.v)==={json.dumps(vA)}"))
    n=B.evaluate('A.nextSeq'); B.evaluate("propose([{op:'set',path:'joys/i3/value',value:2}])")
    check('after reload bob continues its own seq (no overwrite)', until(A,"A.view.v['joys/i3/value']===2") and B.evaluate(f"A.nextSeq==={n+1}"))
    A.reload()
    check('Remember for this tab restores session after reload', until(A,"A.login==='alice' && A.synced"))
    A.click('#bSignOut')
    check('sign out clears memory + sessionStorage and stops polling', A.evaluate("!sessionStorage.getItem('atlasSyncToken') && A.token===null && !A.running"))
    cfg('revoke='+TB)
    check('401 mid-session signs out with message', until(B,"A.token===null && !A.running && document.getElementById('authMsg').textContent.includes('expired or was revoked')",15), msg(B))
    cfg('revoke=none')
    H=ctx.new_page(); watch(H,'H'); H.goto(url('http://localhost:8798/clients/client.html', BOB)); paste(H, TA, False)
    check('works over http://localhost:8798', until(H,"A.login==='alice' && A.synced && A.view.v['joys/i1/value']===8"))
    H.close()
    check('no JS errors (pageerror/console)', not [e for e in errors if 'Failed to load resource' not in e and 'CORS' not in e and 'ERR_FAILED' not in e], errors)
    b.close()
print(f"\nRESULT {sum(o for _,o in res)}/{len(res)} passed"); print('errors seen:', errors)
