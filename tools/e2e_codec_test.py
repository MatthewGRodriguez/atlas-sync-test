# E2E: binary atlas/1 is the DEFAULT write format; ?codec=json writes JSON; mixed logs read to identical state;
# codec-load / encode failure falls back to JSON for that batch with a visible warning and loses nothing (page + CLI).
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
for w in ('alice','bob','carol','dave'): get(f'/__mock/mkrepo?full={w}/atlas-sync-log&init=1')
R=lambda w: f'{w}/atlas-sync-log'
ALL=','.join(R(w) for w in ('alice','bob','carol','dave'))
DIG="X7.stateDigest(A.view)"
with sync_playwright() as p:
    br=p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--disable-gpu','--no-sandbox','--allow-file-access-from-files'])
    ctx=br.new_context()
    def page(login, extra=''):
        pg=ctx.new_page(); pg.goto(f'{FILE}?api={M}&poll=2&autostart=1&peers={ALL}{extra}'); pg.fill('#fToken',f'test-valid-{login}-c'); pg.click('#bConnect')
        until(pg,f"A.login==='{login}' && A.synced"); return pg
    A=page('alice')
    check('default page: binary codec ready (embedded copy or local bundle), Write JSON unticked', A.evaluate("X7.codecMode()==='bin' && !$('fCodec').checked && !document.querySelector('script[src]:not([src*=atlas_codec])')"))
    A.evaluate("propose([{op:'set',path:'joys/i1/value',value:21},{op:'add',path:'items/i1/notes',value:'bin ✓'}])"); until(A,"A.pending.length===0")
    fa=[f for f in files(R('alice')) if f.startswith('log/')]
    check('default writes log/alice/000001.bin with JRBA magic', fa==['log/alice/000001.bin'] and blob(R('alice'),fa[0])[:4]==b'JRBA', fa)
    B=page('bob','&codec=json')
    check('?codec=json ticks Write JSON (debug)', B.evaluate("$('fCodec').checked && X7.codecMode()==='json'"))
    B.evaluate("propose([{op:'set',path:'joys/i3/value',value:5},{op:'add',path:'items/i1/notes',value:'json ✓'}])"); until(B,"A.pending.length===0")
    fb=[f for f in files(R('bob')) if f.startswith('log/')]
    check('?codec=json writes log/bob/000001.json (plain JSON)', fb==['log/bob/000001.json'] and json.loads(blob(R('bob'),fb[0]))['ops'][0]['value']==5, fb)
    C=page('carol','&nocodec=1')
    check('codec load failure: visible warning, still a writer', until(C,"!$('codecWarn').hidden && /fall back to JSON/.test($('codecWarn').textContent)"), C.evaluate("$('codecWarn').textContent"))
    C.evaluate("propose([{op:'delta',path:'joys/i3/value',by:2}])"); C.evaluate("propose([{op:'add',path:'items/i1/notes',value:'fallback ✓'}])")
    check('codec load failure: both batches written as .json, queue drained', until(C,"A.pending.length===0") and sorted(f for f in files(R('carol')) if f.startswith('log/'))==['log/carol/000001.json','log/carol/000002.json'], files(R('carol')))
    check('codec load failure: each fallback write is reported (A.codecFallbacks, error log)', C.evaluate("A.codecFallbacks>=2 && A.errors.some(e=>/saved as JSON instead; nothing lost/.test(e))"))
    A.evaluate("window.__real=AtlasCodec.create(ATLAS_CODEC_WASM); X7.setBinaryCodec({encode(){throw new Error('simulated encode failure')}, decode:b=>__real.decode(b)})")
    A.evaluate("propose([{op:'set',path:'joys/i2/value',value:3}])")
    check('mid-session encode failure: that batch is written as .json with a warning, nothing lost', until(A,"A.pending.length===0") and 'log/alice/000002.json' in files(R('alice')) and A.evaluate("!$('codecWarn').hidden && A.codecFallbacks>=1"))
    A.evaluate("X7.setBinaryCodec(__real); setCodec(false)"); A.evaluate("propose([{op:'delta',path:'joys/i2/value',by:1}])")
    check('codec restored: next batch is .bin again, warning cleared', until(A,"A.pending.length===0") and 'log/alice/000003.bin' in files(R('alice')) and A.evaluate("$('codecWarn').hidden"))
    r=cli('propose','[{"op":"set","path":"joys/i4/value","value":9}]', token='test-valid-dave-c')
    check('CLI default writes .bin', r.returncode==0 and 'log/dave/000001.bin' in r.stdout and blob(R('dave'),'log/dave/000001.bin')[:4]==b'JRBA', r.stdout+r.stderr)
    r=cli('propose','[{"op":"delta","path":"joys/i4/value","by":1}]','--codec','json', token='test-valid-dave-c')
    check('CLI --codec json writes .json', r.returncode==0 and 'log/dave/000002.json' in r.stdout, r.stdout+r.stderr)
    r=cli('propose','[{"op":"delta","path":"joys/i4/value","by":1}]', token='test-valid-dave-c', nocodec=True)
    check('CLI codec load failure: writes .json with a warning, exit 0', r.returncode==0 and 'log/dave/000003.json' in r.stdout and 'written as JSON instead' in r.stderr, r.stdout+r.stderr)
    check('CLI token never written to the state dir', not any('test-valid' in open(os.path.join(SD,f)).read() for f in os.listdir(SD)))
    for pg in (A,B,C): pg.evaluate("schedulePoll(100)")
    V=ctx.new_page(); V.goto(f'{FILE}?api={M}&poll=2&autostart=1&peers={ALL}')
    want="A.view.v['joys/i4/value']===11 && A.view.v['joys/i3/value']===7 && A.view.v['joys/i2/value']===4 && (A.view.v['items/i1/notes']||[]).length===3"
    check('fresh anonymous reader reads the mixed JSON + .bin log (all writes present)', until(V,f"A.synced && {want}",40), V.evaluate("A.view.v"))
    d=V.evaluate(DIG)
    check('bin writer and json-debug writer replicas reach the identical state', all(until(pg,f"{DIG}==={json.dumps(d)}",40) for pg in (A,B)))
    check('codec-less page reports binary segments it cannot decode (clear error, no guess)', until(C,"A.errors.some(e=>/Binary codec|cannot decode|codec not loaded/.test(e))"), C.evaluate("A.errors"))
    r=cli('digest','--peers',ALL)
    check('anonymous CLI read of the mixed log == page state, byte-identical', r.returncode==0 and r.stdout==d, r.stderr[:300])
    br.close()
print(f'\nRESULT {sum(res)}/{len(res)} passed'); raise SystemExit(0 if all(res) else 1)
