# E2E (ADR 0113): binary atlas/1 is the ONLY write format (page + CLI). No JSON write path, no ?codec=json, no JSON fallback.
# No codec / encode failure: the batch stays QUEUED (op form, sessionStorage / CLI outbox) with a visible error, nothing is written
# in any format, nothing lost; once the codec is available it is written as .bin. Legacy .json segments stay readable.
# Run with a FRESH mock: tools/run_e2e.sh tools/e2e_codec_test.py   (ports 18799 mock, 8798 static). SYNTHETIC tokens only.
import json, time, subprocess, urllib.request, os, tempfile, base64
from playwright.sync_api import sync_playwright
M='http://localhost:18799'; ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILE='file://'+ROOT+'/clients/client.html'; res=[]
def get(p): return json.load(urllib.request.urlopen(M+p))
def check(n, ok, info=''): res.append(bool(ok)); print(('PASS' if ok else 'FAIL'), n, '' if ok else info, flush=True)
def until(pg, js, t=30):
    end=time.time()+t
    while time.time()<end:
        try:
            if pg.evaluate(js): return True
        except Exception: pass
        time.sleep(0.3)
    return False
def files(full): return [f for c in get('/__mock/state')[full]['commits'] for f in c['files']]
def blob(full, path):
    tr=get(f'/repos/{full}/git/trees/'+get(f'/repos/{full}/git/ref/heads/main')['object']['sha']+'?recursive=1')
    return base64.b64decode(get(f'/repos/{full}/git/blobs/'+[e['sha'] for e in tr['tree'] if e['path']==path][0])['content'])
SD=tempfile.mkdtemp(prefix='atlas-codec-test-')
def cli(*a, token=None, nocodec=False):
    env=dict(os.environ); env.pop('ATLAS_TOKEN', None); env.pop('ATLAS_NO_CODEC', None)
    if token: env['ATLAS_TOKEN']=token
    if nocodec: env['ATLAS_NO_CODEC']='1'
    return subprocess.run(['node','clients/atlas-cli.js',*a,'--api',M,'--state',SD], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
for w in ('alice','bob','carol','dave','erin'): get(f'/__mock/mkrepo?full={w}/atlas-sync-log&init=1')
def put_legacy_json(login, seq, ts, ops):   # an OLD .json segment as earlier tests wrote it (written straight to the mock, not by our code)
    body=json.dumps({'v':2,'atlas':'demo','writer':login,'seq':seq,'ts':ts,'createdAt':'2026-10-01T00:00:00Z','ops':ops}, indent=1).encode()
    rq=urllib.request.Request(f'{M}/repos/{login}/atlas-sync-log/contents/log/{login}/{seq:06d}.json', method='PUT',
        data=json.dumps({'message':'legacy json segment','content':base64.b64encode(body).decode()}).encode(),
        headers={'Authorization':f'Bearer test-valid-{login}-legacy','Content-Type':'application/json'})
    return urllib.request.urlopen(rq).status
put_legacy_json('erin', 1, 1000, [{'op':'set','path':'joys/i5/value','value':6},{'op':'add','path':'items/i1/notes','value':'legacy ✓'}])
R=lambda w: f'{w}/atlas-sync-log'
ALL=','.join(R(w) for w in ('alice','bob','carol','dave','erin'))
DIG="X7.stateDigest(A.view)"
with sync_playwright() as p:
    br=p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--disable-gpu','--no-sandbox','--allow-file-access-from-files'])
    ctx=br.new_context()
    def page(login, extra=''):
        pg=ctx.new_page(); pg.goto(f'{FILE}?api={M}&poll=2&autostart=1&peers={ALL}{extra}'); pg.fill('#fToken',f'test-valid-{login}-c'); pg.click('#bConnect')
        until(pg,f"A.login==='{login}' && A.synced"); return pg
    logf=lambda w: sorted(f for f in files(R(w)) if f.startswith('log/'))
    A=page('alice')
    check('default page: codec ready, no Write JSON option, state says binary', A.evaluate("X7.codecMode()==='bin' && !$('fCodec') && /codec loaded/.test($('codecState').textContent) && !document.querySelector('script[src]:not([src*=atlas_codec])')"))
    A.evaluate("propose([{op:'set',path:'joys/i1/value',value:21},{op:'add',path:'items/i1/notes',value:'bin ✓'}])"); until(A,"A.pending.length===0")
    check('writes log/alice/000001.bin with JRBA magic', logf('alice')==['log/alice/000001.bin'] and blob(R('alice'),'log/alice/000001.bin')[:4]==b'JRBA', logf('alice'))
    B=page('bob','&codec=json')
    B.evaluate("propose([{op:'set',path:'joys/i3/value',value:5},{op:'add',path:'items/i1/notes',value:'bob ✓'}])"); until(B,"A.pending.length===0")
    check('?codec=json is gone: ignored, bob still writes .bin', logf('bob')==['log/bob/000001.bin'] and blob(R('bob'),'log/bob/000001.bin')[:4]==b'JRBA', logf('bob'))
    C=page('carol','&nocodec=1&codecretry=1500')
    check("no codec: clear 'codec required to write' state", until(C,"/Codec required to write/.test($('codecState').textContent) && !$('codecWarn').hidden && X7.codecMode()==='none'"), C.evaluate("$('codecState').textContent+' | '+$('codecWarn').textContent"))
    c3=C.evaluate("A.view.v['joys/i3/value']"); C.evaluate("propose([{op:'delta',path:'joys/i3/value',by:2}])"); C.evaluate("propose([{op:'add',path:'items/i1/notes',value:'queued ✓'}])"); time.sleep(3)
    check('no codec: both batches stay queued, NOTHING written to GitHub in any format', C.evaluate("A.pending.length===2 && A.pending.every(b=>b.state==='queued')") and logf('carol')==[] and C.evaluate("A.errors.some(e=>/Codec required to write.*nothing lost, nothing written/.test(e))"), [logf('carol'), C.evaluate("A.errors")])
    q=C.evaluate("sessionStorage.getItem('atlasSyncQueue')")
    check('queue mirrored to sessionStorage in op form (not an encoded file, no token)', q and [b['ops'][0]['op'] for b in json.loads(q)]==['delta','add'] and 'test-valid' not in q, q)
    check('local view already shows the queued changes (optimistic, nothing lost)', C.evaluate(f"A.view.v['joys/i3/value']==={c3}+2 && A.view.v['items/i1/notes'].includes('queued ✓')"), C.evaluate("A.view.v"))
    C.reload(); C.fill('#fToken','test-valid-carol-c'); C.click('#bConnect'); until(C,"A.login==='carol' && A.synced"); time.sleep(2)
    check('reload while codec missing: queue restored from sessionStorage, still nothing written', C.evaluate("A.pending.length===2 && A.pending.every(b=>b.state==='queued')") and logf('carol')==[], logf('carol'))
    C.evaluate("noCodecOverride=false")   # the codec becomes available; the page's own retry timer picks it up
    check('codec becomes available: queue drains automatically as .bin (JRBA), sessionStorage cleared, warning gone',
        until(C,"A.pending.length===0",30) and logf('carol')==['log/carol/000001.bin','log/carol/000002.bin'] and all(blob(R('carol'),f)[:4]==b'JRBA' for f in logf('carol'))
        and C.evaluate("sessionStorage.getItem('atlasSyncQueue')===null && $('codecWarn').hidden && X7.codecMode()==='bin'"), logf('carol'))
    A.evaluate("window.__real=AtlasCodec.create(ATLAS_CODEC_WASM); X7.setBinaryCodec({encode(){throw new Error('simulated encode failure')}, decode:b=>__real.decode(b)})")
    A.evaluate("propose([{op:'set',path:'joys/i2/value',value:3}])"); time.sleep(3)
    check('mid-session encode failure: batch stays queued with a visible error, no file written', A.evaluate("A.pending.length===1 && A.pending[0].state==='queued' && !$('codecWarn').hidden && /simulated encode failure/.test($('codecWarn').textContent)") and logf('alice')==['log/alice/000001.bin'], logf('alice'))
    A.evaluate("X7.setBinaryCodec(__real); retryCodec()")
    check('codec restored: the same batch is written as .bin (seq 2), warning cleared', until(A,"A.pending.length===0") and logf('alice')==['log/alice/000001.bin','log/alice/000002.bin'] and A.evaluate("$('codecWarn').hidden"), logf('alice'))
    r=cli('propose','[{"op":"set","path":"joys/i4/value","value":9}]', token='test-valid-dave-c')
    check('CLI writes .bin', r.returncode==0 and 'log/dave/000001.bin' in r.stdout and blob(R('dave'),'log/dave/000001.bin')[:4]==b'JRBA', r.stdout+r.stderr)
    r=cli('propose','[{"op":"delta","path":"joys/i4/value","by":1}]','--codec','json', token='test-valid-dave-c')
    check('CLI --codec json is refused (non-zero), nothing written', r.returncode!=0 and 'only write format' in r.stderr and logf('dave')==['log/dave/000001.bin'], r.stdout+r.stderr)
    r=cli('propose','[{"op":"delta","path":"joys/i4/value","by":1}]', token='test-valid-dave-c', nocodec=True)
    ob=os.path.join(SD,'outbox.json'); jl=open(os.path.join(SD,'journal.ndjson')).read()
    check('CLI without codec: exits 4, nothing written, batch kept in outbox + journal "queued"', r.returncode==4 and 'codec required to write' in r.stderr and logf('dave')==['log/dave/000001.bin']
        and os.path.exists(ob) and json.load(open(ob))['ops'][0]['by']==1 and '"queued"' in jl, r.stdout+r.stderr)
    r=cli('flush', token='test-valid-dave-c')
    check('CLI flush with the codec: queued batch written as .bin, outbox cleared', r.returncode==0 and 'log/dave/000002.bin' in r.stdout and not os.path.exists(ob) and blob(R('dave'),'log/dave/000002.bin')[:4]==b'JRBA', r.stdout+r.stderr)
    check('CLI token never written to the state dir', not any('test-valid' in open(os.path.join(SD,f)).read() for f in os.listdir(SD)))
    for pg in (A,B,C): pg.evaluate("schedulePoll(100)")
    V=ctx.new_page(); V.goto(f'{FILE}?api={M}&poll=2&autostart=1&peers={ALL}')
    want="A.view.v['joys/i4/value']===10 && A.view.v['joys/i3/value']===7 && A.view.v['joys/i2/value']===3 && A.view.v['joys/i5/value']===6 && (A.view.v['items/i1/notes']||[]).length===4"
    check('fresh anonymous reader reads .bin + the OLD legacy .json segment (all writes present)', until(V,f"A.synced && {want}",40), V.evaluate("A.view.v"))
    d=V.evaluate(DIG)
    r=cli('digest','--peers',ALL)
    check('all replicas identical; anonymous CLI read (incl. legacy .json) == page state', all(until(pg,f"{DIG}==={json.dumps(d)}",40) for pg in (A,B,C)) and r.returncode==0 and r.stdout==d, r.stderr[:300])
    N=ctx.new_page(); N.goto(f'{FILE}?api={M}&poll=2&autostart=1&peers={R("erin")},{R("alice")}&nocodec=1')
    check('codec-less reader: legacy .json readable, binary segments reported clearly (no guess)', until(N,"A.synced && A.view.v['joys/i5/value']===6 && A.errors.some(e=>/Binary codec|cannot decode|codec not loaded/.test(e))",40), N.evaluate("A.errors"))
    br.close()
print(f'\nRESULT {sum(res)}/{len(res)} passed'); raise SystemExit(0 if all(res) else 1)
