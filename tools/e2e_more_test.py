# E2E (doc 47): conflict/LWW, opt-in binary codec, per-writer compaction, snapshots, page-vs-Node replay.
# Run with a FRESH mock: tools/run_e2e.sh tools/e2e_more_test.py   (ports 18799 mock, 8798 static). SYNTHETIC tokens only.
import json, time, subprocess, urllib.request, os
from playwright.sync_api import sync_playwright
M='http://localhost:18799'; ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILE='file://'+ROOT+'/clients/client.html'
def get(path): return json.load(urllib.request.urlopen(M+path))
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
def url(peers, extra=''): return f'{FILE}?api={M}&poll=2&autostart=1&peers={peers}{extra}'
def connect(pg, tok): pg.fill('#fToken', tok); pg.click('#bConnect')
ALICE='alice/atlas-sync-log'; BOB='bob/atlas-sync-log'
get('/__mock/mkrepo?full=alice/atlas-sync-log&init=1'); get('/__mock/mkrepo?full=bob/atlas-sync-log&init=1')
DIG="X7.stateDigest(A.view)"
def ddiff(x,y):
    a,b=json.loads(x),json.loads(y); out=[]
    for k in ('v','rev'):
        for q in sorted(set(a.get(k,{}))|set(b.get(k,{}))):
            if a.get(k,{}).get(q)!=b.get(k,{}).get(q): out.append((k,q,a.get(k,{}).get(q),b.get(k,{}).get(q)))
    return out[:6] or [list(a), list(b)]
def idle(*pgs): return all(until(p,"A.pending.length===0",40) for p in pgs)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--disable-gpu','--no-sandbox','--allow-file-access-from-files'])
    ctx=b.new_context()
    A=ctx.new_page(); watch(A,'alice'); A.goto(url(BOB)); connect(A,'test-valid-alice-m')
    B=ctx.new_page(); watch(B,'bob'); B.goto(url(ALICE)); connect(B,'test-valid-bob-m')
    check('both signed in and synced', until(A,"A.login==='alice' && A.synced") and until(B,"A.login==='bob' && A.synced"))
    check('core inlined (Exp7Sync present, one HTML file)', A.evaluate("typeof Exp7Sync==='object' && !document.querySelector('script[src]')"))
    # ---- (b) conflict: two writers set the same path at the same instant (forced equal ts) ----
    T0=int(time.time()*1000)+5000
    for pg in (A,B): pg.evaluate(f"window.__dn=Date.now; A.lastTs={T0-1}; Date.now=()=>{T0};")
    A.evaluate("propose([{op:'set',path:'joys/i3/value',value:7}])"); B.evaluate("propose([{op:'set',path:'joys/i3/value',value:9}])")
    idle(A,B)
    for pg in (A,B): pg.evaluate("Date.now=window.__dn")
    conv=until(A,"A.view.v['joys/i3/value']===9 && A.view.rev['joys/i3/value'].owner==='bob'") and until(B,"A.view.v['joys/i3/value']===9")
    check('same-ts conflict: deterministic tie-break by writer id -> bob (b > a) wins on both', conv, (A.evaluate("A.view.v['joys/i3/value']"), B.evaluate("A.view.v['joys/i3/value']")))
    check('both replicas converge to identical state (digest)', until(A, f"{DIG}==={json.dumps(B.evaluate(DIG))}"))
    check("alice gets 'overwrote' (yours alice:N, theirs bob:N) + CHANGED event line", until(A,"A.reports.some(r=>r.type==='overwrote' && r.path==='joys/i3/value' && r.by==='bob' && /^alice:/.test(r.yours) && /^bob:/.test(r.theirs))") and A.evaluate("[...document.querySelectorAll('.ev-changed')].some(e=>e.textContent.includes('joys/i3/value'))"), A.evaluate("A.reports"))
    check("bob gets 'changed' {path, from:'alice'} for his winning write", until(B,"A.reports.some(r=>r.type==='changed' && r.path==='joys/i3/value' && r.from==='alice')"), B.evaluate("A.reports"))
    # near-simultaneous with real clocks: winner = max (ts, writer, seq)
    A.evaluate("propose([{op:'set',path:'joys/i2/value',value:1}])"); B.evaluate("propose([{op:'set',path:'joys/i2/value',value:2}])"); idle(A,B)
    until(A,"[...A.confirmed.values()].filter(c=>c.seg.ops.some(o=>o.path==='joys/i2/value')).length===2"); until(B,"[...A.confirmed.values()].filter(c=>c.seg.ops.some(o=>o.path==='joys/i2/value')).length===2")
    win=A.evaluate("(()=>{const l=[...A.confirmed.values()].filter(c=>c.seg.ops.some(o=>o.path==='joys/i2/value')).sort(X7.cmpOrder); return l[l.length-1].seg.ops[0].value})()")
    check('near-simultaneous real-clock conflict: both hold the max-(ts,writer,seq) value', until(A,f"A.view.v['joys/i2/value']==={win}") and until(B,f"A.view.v['joys/i2/value']==={win} && {DIG}==={json.dumps(A.evaluate(DIG))}"), win)
    # ---- (a) opt-in binary codec ----
    A.evaluate("setCodec(true)")
    check('binary codec loads on demand from atlas_codec.bundle.js (opt-in)', until(A,"X7.codecMode()==='bin'"))
    A.evaluate("propose([{op:'set',path:'joys/i1/value',value:11},{op:'add',path:'items/i1/notes',value:'é ✓'}])"); idle(A)
    st=get('/__mock/state'); binf=[f for c in st[ALICE]['commits'] for f in c['files'] if f.endswith('.bin')]
    check('segment written via Contents API as log/alice/<seq>.bin (201)', len(binf)==1 and binf[0].startswith('log/alice/'), binf)
    check('JSON-default reader (bob) auto-loads the codec and converges', until(B,"A.view.v['joys/i1/value']===11 && (A.view.v['items/i1/notes']||[]).includes('é ✓') && X7.codecMode()==='json'"))
    tr=get('/repos/alice/atlas-sync-log/git/trees/'+get('/repos/alice/atlas-sync-log/git/ref/heads/main')['object']['sha']+'?recursive=1')
    sha=[e['sha'] for e in tr['tree'] if e['path']==binf[0]][0]; import base64; raw=base64.b64decode(get('/repos/alice/atlas-sync-log/git/blobs/'+sha)['content'])
    check('stored blob is the binary container (JRBA magic), not JSON', raw[:4]==b'JRBA', raw[:8])
    N=A.context.new_page(); watch(N,'nocodec'); N.goto(url(ALICE,'&codecsrc=missing_codec.js'))
    check('reader without the bundle reports a clear error and skips (no guess)', until(N,"A.errors.some(e=>e.includes('Binary codec: cannot load'))"))
    N.close(); A.evaluate("setCodec(false)"); until(A,"X7.codecMode()==='json'")
    # ---- (c) compaction (own segments, one Git Data commit) ----
    for i in range(4): A.evaluate(f"propose([{{op:'delta',path:'joys/i1/value',by:1}}])"); idle(A)
    before=sorted(get('/__mock/state')[ALICE]['paths']) if 'paths' in get('/__mock/state')[ALICE] else None
    dA=A.evaluate(DIG); r=A.evaluate("compactOwn()")
    st=get('/__mock/state')[ALICE]; paths=st.get('paths',[])
    packs=[x for x in paths if '/pack-' in x]; singles=[x for x in paths if x.startswith('log/alice/') and '/pack-' not in x]
    check('compaction: own singles packed in ONE commit, singles deleted', r['packs']>=1 and len(packs)==r['packs'] and len(singles)<=1 and st['commits'][-1]['message'].startswith('atlas:demo writer:alice compact'), (r, packs, singles))
    check('compaction wrote only my own folder', all(x.startswith('log/alice/') for x in st['commits'][-1]['files']), st['commits'][-1]['files'])
    check('after compaction alice and bob keep identical state', until(A,f"{DIG}==={json.dumps(dA)}") and until(B,f"{DIG}==={json.dumps(dA)}"))
    V=ctx.new_page(); watch(V,'viewer'); V.goto(url(ALICE+','+BOB,'&anonmin=1'))
    check('fresh anonymous reader reads packs (+.bin pack) -> identical state', until(V,f"A.synced && {DIG}==={json.dumps(dA)}",40), V.evaluate(DIG)[:200])
    V.close()
    r2=A.evaluate("compactOwn()"); check('compact again: nothing to pack -> no commit (rule 14)', r2['packs']==0 and len(get('/__mock/state')[ALICE]['commits'])==len(st['commits']))
    A.evaluate("propose([{op:'set',path:'joys/i3/value',value:5}])"); idle(A)
    check('writing continues after compaction (next seq, no collision)', until(B,"A.view.v['joys/i3/value']===5"))
    # ---- snapshots (cache) ----
    sp=A.evaluate("publishSnapshot()"); check('snapshot published in own repo', bool(sp) and sp.startswith('snapshots/alice/'), sp)
    dA=A.evaluate(DIG)
    S=ctx.new_page(); watch(S,'snap'); S.goto(url(ALICE+','+BOB,'&anonmin=1&usesnap=1'))
    check('reader with ?usesnap=1 starts from the snapshot and gets identical state', until(S,f"A.synced && A.snap && {DIG}==={json.dumps(dA)}",40) and S.evaluate("A.confirmed.size") < A.evaluate("A.confirmed.size"), (S.evaluate("[A.synced,!!A.snap,A.confirmed.size,A.errors.slice(-3),[...document.querySelectorAll('#events div')].slice(-6).map(e=>e.textContent)]"), ddiff(S.evaluate(DIG), dA)))
    B.evaluate("propose([{op:'delta',path:'joys/i1/value',by:10}])"); idle(B)
    check('snapshot reader applies new segments on top', until(S,f"{DIG}==={json.dumps(B.evaluate(DIG))}",40) and until(S, f"{DIG}==={json.dumps(A.evaluate(DIG))}",40))
    S.close()
    # ---- page vs Node replay byte-identical (shared core) ----
    dump=A.evaluate("JSON.stringify({seed:SEED, entries:sortedConfirmed().map(c=>({repo:c.repo, seg:c.seg, path:c.path}))})")
    node=subprocess.run(['node','-e',"const X=require('./clients/exp7-sync-core.js');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(X.stateDigest(X.replay(j.entries.map(e=>X.entry(e.repo,e.seg,e.path)),j.seed).S))})"],input=dump,capture_output=True,text=True,cwd=ROOT)
    check('Node core replay of the page segments == page state (byte-identical)', node.stdout==A.evaluate(DIG), node.stderr[:300])
    check('no JS errors', not [e for e in errors if 'Failed to load resource' not in e and 'ERR_FILE_NOT_FOUND' not in e], errors)
    b.close()
print(f"\nRESULT {sum(o for _,o in res)}/{len(res)} passed")
