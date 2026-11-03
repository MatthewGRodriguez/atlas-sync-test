#!/bin/sh
# Fresh mock (18799) + static server (8798), run an e2e script, stop both. usage: tools/run_e2e.sh [tools/e2e_test.py]
cd "$(dirname "$0")/.." || exit 1
T=${1:-tools/e2e_test.py}
node tools/mock_github.js --port 18799 > /tmp/atlas_mock.log 2>&1 & M=$!
python3 -m http.server 8798 --bind 127.0.0.1 > /tmp/atlas_http.log 2>&1 & H=$!
sleep 1; python3 "$T"; R=$?; kill $M $H 2>/dev/null; exit $R
