# Page + CLI against the mock (doc 47 P1). Run: tools/run_e2e.sh tools/cli_e2e_test.py   SYNTHETIC tokens only.
import json, time, subprocess, urllib.request, os, tempfile, shutil
from playwright.sync_api import sync_playwright
M='http://localhost:18799'; ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILE='file://'+ROOT+'/clients/client.html'; res=[]
def get(p): return json.load(urllib.request.urlopen(M+p))
def check(n, ok, info=''): res.append(ok); print(('PASS' if ok else 'FAIL'), n, '' if ok else info, flush=True)
SD=tempfile.mkdtemp(prefix='atlas-cli-test-')
def cli(*a, token=None):
    env=dict(os.environ); env.pop('ATLAS_TOKEN', None)
    if token: env['ATLAS_TOKEN']=token
    return subprocess.run(['node','clients/atlas-cli.js',*a,'--api',M,'--state',SD], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
def until(pg, js, t=30):
    end=time.time()+t
    while time.time()<end:
        try:
            if pg.evaluate(js): return True
        except Exception: pass
        time.sleep(0.3)
    return False
get('/__mock/mkrepo?full=alice/atlas-sync-log&init=1'); get('/__mock/mkrepo?full=bob/atlas-sync-log&init=1')
AL='test-valid-alice-cli'
try:
    r=cli('propose','[{"op":"set","path":"joys/i1/value","value":8}]', token=AL)
    check('CLI propose writes log/alice/000001.json', r.returncode==0 and 'log/alice/000001.json' in r.stdout, r.stderr)
    r=cli('propose','[{"op":"add","path":"joys/i1/value","value":1}]', token=AL)
    check('CLI rejects an invalid batch locally (add on scalar = exists), nothing written', r.returncode!=0 and 'exists' in r.stderr and len(get('/__mock/state')['alice/atlas-sync-log']['commits'])==2, r.stderr)
    r=cli('propose','[{"op":"set","path":"x","value":1}]')
    check('CLI write without ATLAS_TOKEN refused', r.returncode!=0 and 'ATLAS_TOKEN' in r.stderr)
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--disable-gpu','--no-sandbox','--allow-file-access-from-files'])
        B=b.new_context().new_page(); B.goto(f'{FILE}?api={M}&poll=2&autostart=1&peers=alice/atlas-sync-log'); B.fill('#fToken','test-valid-bob-cli'); B.click('#bConnect')
        check('page (bob) sees the CLI write', until(B,"A.synced && A.view.v['joys/i1/value']===8"))
        B.evaluate("propose([{op:'set',path:'joys/i1/value',value:2},{op:'add',path:'items/i2/notes',value:'from page'}])"); until(B,"A.pending.length===0")
        for i in range(3): B.evaluate("propose([{op:'delta',path:'joys/i2/value',by:1}])"); until(B,"A.pending.length===0")
        B.evaluate("compactOwn()")
        time.sleep(1)
        r=cli('digest','--repo','alice/atlas-sync-log','--peers','bob/atlas-sync-log')
        check('anonymous CLI read (incl. bob pack) == page state, byte-identical', r.returncode==0 and r.stdout==B.evaluate("X7.stateDigest(A.view)"), r.stderr[:300])
        r=cli('status', token=AL)
        st=json.loads(r.stdout) if r.returncode==0 else {}
        check('CLI status (alice, own repo only) lists writer alice', st.get('writers')==['alice'] and st.get('segments')==1, r.stdout+r.stderr)
        # crash between outbox write and PUT: outbox survives -> flush sends with the same seq; re-flush idempotent
        json.dump({'seq':2,'ts':int(time.time()*1000),'ops':[{'op':'set','path':'joys/i3/value','value':1}]}, open(os.path.join(SD,'outbox.json'),'w'))
        r=cli('flush', token=AL)
        check('outbox recovery: flush writes the pending batch as seq 2', r.returncode==0 and 'log/alice/000002.json' in r.stdout and not os.path.exists(os.path.join(SD,'outbox.json')), r.stdout+r.stderr)
        check('page sees the flushed write', until(B,"A.view.v['joys/i3/value']===1"))
        json.dump({'seq':2,'ts':1,'ops':[{'op':'set','path':'joys/i3/value','value':1}]}, open(os.path.join(SD,'outbox.json'),'w'))
        n=len(get('/__mock/state')['alice/atlas-sync-log']['commits']); r=cli('flush', token=AL)
        check('re-flush of an already-written batch: 422 + same ops = done, no duplicate', r.returncode==0 and len(get('/__mock/state')['alice/atlas-sync-log']['commits'])==n, r.stdout+r.stderr)
        w=subprocess.Popen(['node','clients/atlas-cli.js','watch','--every','1','--count','6','--api',M,'--repo','alice/atlas-sync-log','--peers','bob/atlas-sync-log'], cwd=ROOT, stdout=subprocess.PIPE, text=True, env={k:v for k,v in os.environ.items() if k!='ATLAS_TOKEN'})
        time.sleep(1.5); B.evaluate("propose([{op:'set',path:'dates/start/value',value:'2026-12-02'}])")
        o=w.communicate(timeout=60)[0]
        check('CLI watch prints the page change with owner', 'dates/start/value = "2026-12-02"  (bob)' in o, o)
        jl=open(os.path.join(SD,'journal.ndjson')).read()
        check('journal holds writes, never the token', 'log/alice/000001.json' in jl and 'test-valid' not in jl and 'test-valid' not in open(os.path.join(ROOT,'clients/atlas-cli.js')).read())
        b.close()
finally: shutil.rmtree(SD, ignore_errors=True)
print(f"\nRESULT {sum(res)}/{len(res)} passed")
