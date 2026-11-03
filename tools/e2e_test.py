import json, time, urllib.request, sys
from playwright.sync_api import sync_playwright
M='http://localhost:18799'
def cfg(q): return json.load(urllib.request.urlopen(M+'/__mock/config?'+q))
FILE='file:///workspace/atlas-sync-test/clients/client.html'
def url(base,w): return f'{base}?writer={w}&api={M}&auth={M}&client_id=mock-public-client-id&poll=2&autostart=1'
res=[]; errors=[]
def check(name, ok, info=''):
    res.append((name, bool(ok))); print(('PASS' if ok else 'FAIL'), name, info, flush=True)
def until(pg, js, t=25):
    end=time.time()+t
    while time.time()<end:
        try:
            if pg.evaluate(js): return True
        except Exception as e: pass
        time.sleep(0.3)
    return False
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--disable-gpu','--no-sandbox'])
    ctx=b.new_context()
    ctx.on('page', lambda pg: pg.url.startswith(M+'/login/device') and pg.close())
    pages={}
    for w in 'AB':
        pg=ctx.new_page(); pg.on('pageerror', lambda e,w=w: errors.append(f'{w}: {e}'))
        pg.on('console', lambda m,w=w: m.type=='error' and errors.append(f'{w} console: {m.text}'))
        pg.goto(url(FILE,w)); pages[w]=pg
    A,B=pages['A'],pages['B']
    check('parses from file:// (script ran)', A.evaluate("typeof applyOp==='function' && location.protocol==='file:'"))
    for w,pg in pages.items():
        pg.click('#bDevice')
        check(f'{w} device-flow sign-in (mock, CORS on)', until(pg,"A.login && A.login.startsWith('synthetic-user')"), pg.evaluate('A.login'))
    check('token not in localStorage', A.evaluate("localStorage.length===0") and A.evaluate("!!sessionStorage.getItem('atlasSyncToken')"))
    until(A,'A.synced'); until(B,'A.synced')
    # 1 A changes -> B sees
    A.fill('[data-joy=i2]','9'); A.dispatch_event('[data-joy=i2]','change')
    check('B sees A set joys/i2=9', until(B,"A.view.v['joys/i2/value']===9"))
    # 2 B overwrites same path -> A gets changed event
    B.fill('[data-joy=i2]','7'); B.dispatch_event('[data-joy=i2]','change')
    check('A converges to B value 7 (LWW)', until(A,"A.view.v['joys/i2/value']===7 && A.view.rev['joys/i2/value'].owner==='B'"))
    check('A got CHANGED event', until(A,"[...document.querySelectorAll('.ev-changed')].some(e=>e.textContent.includes('joys/i2/value'))"), A.evaluate("document.querySelector('.ev-changed')?.textContent"))
    # 3 concurrent deltas add up: seed 3, +2 from A, +3 from B => 8
    A.evaluate("propose([{op:'delta',path:'joys/i1/value',by:2}])"); B.evaluate("propose([{op:'delta',path:'joys/i1/value',by:3}])")
    ok=until(A,"A.view.v['joys/i1/value']===8 && A.pending.length===0",30) and until(B,"A.view.v['joys/i1/value']===8 && A.pending.length===0",30)
    check('concurrent deltas add up to 8 on both', ok, (A.evaluate("A.view.v['joys/i1/value']"), B.evaluate("A.view.v['joys/i1/value']")))
    # 4 empty batch
    n=A.evaluate('A.nextSeq'); A.click('#bEmpty')
    check('empty batch written', until(A,f"A.nextSeq==={n+1} && A.pending.length===0"))
    # 5 no-op add keeps revision
    A.evaluate("propose([{op:'add',path:'items/i1/notes',value:'bring hat'}])")
    until(B,"(A.view.v['items/i1/notes']||[]).includes('bring hat')")
    r0=B.evaluate("A.view.rev['items/i1/notes'].rev")
    B.evaluate("propose([{op:'add',path:'items/i1/notes',value:'bring hat'}])")
    until(B,"A.pending.length===0"); until(A,"A.pending.length===0"); time.sleep(3)
    check('no-op add leaves revision unchanged', B.evaluate("A.view.rev['items/i1/notes'].rev")==r0==A.evaluate("A.view.rev['items/i1/notes'].rev") and A.evaluate("A.view.rev['items/i1/notes'].owner")=='A', r0)
    # 6 add on existing scalar rejected
    A.evaluate("propose([{op:'add',path:'joys/i3/value',value:1}])")
    check('add on existing scalar rejected (exists)', until(A,"[...document.querySelectorAll('#evlog div')].some(e=>e.textContent.includes('rejected (exists)'))"))
    # 7 remove missing = noop, remove member works
    A.evaluate("propose([{op:'remove',path:'items/i9/notes',value:'zzz'},{op:'remove',path:'items/i2/notes',value:'buy day pass'}])")
    check('remove member propagates; remove missing no-op', until(B,"(A.view.v['items/i2/notes']||[]).length===0 && !('items/i9/notes' in A.view.rev)"))
    # 8 ref + date + pick via UI
    B.check('[data-pick=o2]'); B.fill('#dateIn','2026-12-05'); B.dispatch_event('#dateIn','change')
    check('ref pick + date move reach A', until(A,"A.view.v['alts/g1/pick']==='o2' && A.view.v['dates/start/value']==='2026-12-05'"))
    # 9 403 secondary limit with retry-after
    cfg('fail403=1&failPut409=1')
    A.evaluate("propose([{op:'set',path:'alts/g1/opts/o3/unavail',value:false}])")
    check('403 retry-after + 409 retry then success', until(B,"A.view.v['alts/g1/opts/o3/unavail']===false",40) and A.evaluate("A.errors.some(e=>e.includes('limit hit'))"))
    # writes >=1s apart
    st=json.load(urllib.request.urlopen(M+'/__mock/state'))
    check('every write is one segment file in log/<writer>/', all(c['files'][0].startswith('log/') for c in st['commits'][1:]), f"{len(st['commits'])-1} commits")
    # 10 304 polling and rate limit shown
    check('poll shows 304 and rate remaining', until(A,"A.lastPollResult==='304' && A.rate!=='-'"))
    # 11 reload B -> rebuilds same state from repo
    vA=A.evaluate('JSON.stringify(A.view.v)')
    B.reload(); B.click('#bDevice'); until(B,'A.login'); 
    check('fresh reload of B rebuilds identical state', until(B,f"A.synced && JSON.stringify(A.view.v)==={json.dumps(vA)}"))
    check('sign out clears token', B.evaluate("signOut(), !sessionStorage.getItem('atlasSyncToken') && A.token===null"))
    # 12 CORS-blocked device flow
    cfg('deviceCors=0')
    C=ctx.new_page(); C.goto(url(FILE,'C').replace('autostart=1','autostart=0')); C.click('#bDevice')
    ok=until(C,"document.getElementById('diag').innerText.includes('the block is CORS')")
    check('CORS-blocked device flow -> diagnostics explain CORS, no token', ok and C.evaluate("A.token===null && !document.getElementById('diag').innerText.match(/mock-tok/)"))
    C.close(); cfg('deviceCors=1')
    # 13 http origin
    H=ctx.new_page(); H.on('pageerror', lambda e: errors.append(f'H: {e}')); H.goto(url('http://localhost:8798/clients/client.html','H')); H.click('#bDevice')
    check('works over http://localhost:8798', until(H,"A.login && A.synced && A.view.v['joys/i1/value']===8"))
    H.close()
    check('no JS errors (pageerror/console)', not [e for e in errors if 'Failed to load resource' not in e and 'CORS' not in e and 'ERR_FAILED' not in e], errors)
    b.close()
print(f"\nRESULT {sum(o for _,o in res)}/{len(res)} passed"); print('errors seen:', errors)
