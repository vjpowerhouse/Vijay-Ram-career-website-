#!/bin/sh
# Builds dist/ml-agent-intranet-<version>.zip: only the files the tool needs, plus
# SHA256SUMS.txt so IT can verify integrity. Run from anywhere: ml-agent/package.sh
set -e
cd "$(dirname "$0")"
VERSION="$(date +%Y.%m.%d)-$(git rev-parse --short HEAD 2>/dev/null || echo local)"
OUT="dist/ml-agent-intranet-$VERSION"
rm -rf dist && mkdir -p "$OUT"
cp index.html learn.html style.css web.config README.md DEMO.md DEPLOY.md "$OUT"/
cp engine.js doe.js agent.js samples.js charts.js explain.js app.js learn.js "$OUT"/
cp -r demo-data "$OUT"/
printf 'ML Agent %s\n' "$VERSION" > "$OUT/VERSION.txt"
(cd "$OUT" && find . -type f ! -name SHA256SUMS.txt | sed 's#^\./##' | sort | xargs sha256sum > SHA256SUMS.txt)
(cd dist && python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', '.', sys.argv[1])" "ml-agent-intranet-$VERSION")
echo "Built dist/ml-agent-intranet-$VERSION.zip"
