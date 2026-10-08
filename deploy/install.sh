#!/usr/bin/env bash
#
# deploy/install.sh -- install ScoreForge under /opt/scoreforge and run the
# recognition backend as a systemd service.
#
#   sudo ./deploy/install.sh
#
# Override any of these by exporting before running:
#   PREFIX=/srv/scoreforge  SVC_USER=someone  PYTHON=python3.12
#
# The install is read-only at runtime: model weights are fetched here, while
# the service account can still write nothing, so deploy/install.sh is also the
# upgrade path. Re-run it to pick up a new release.

set -euo pipefail

PREFIX="${PREFIX:-/opt/scoreforge}"
SVC_USER="${SVC_USER:-scoreforge}"
PYTHON="${PYTHON:-python3}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO/deploy/scoreforge.service"
ENV_SRC="$REPO/deploy/scoreforge.env.example"
ETC_DIR="/etc/scoreforge"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)"
command -v "$PYTHON" >/dev/null || die "$PYTHON not found; set PYTHON=python3.11 (homr needs 3.11-3.15)"
command -v systemctl >/dev/null || die "systemctl not found; this installer is for systemd hosts"
[ -f "$REPO/ScoreForge.html" ] || die "ScoreForge.html is not built -- run 'npm install && npm run build' first, or copy the built file into $REPO"

# homr needs 3.11 or newer; 3.16+ is not tested.
"$PYTHON" - <<'PY' || die "$PYTHON is too old or too new for homr (needs 3.11-3.15)"
import sys
raise SystemExit(0 if (3, 11) <= sys.version_info[:2] <= (3, 15) else 1)
PY

# ---------------------------------------------------------------- service user
say "Creating service account $SVC_USER"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
else
    echo "    already exists"
fi

# ------------------------------------------------------------------- copy tree
say "Installing to $PREFIX"
# The repository is read-only at runtime, so it only needs to be root-owned.
install -d -m 0755 "$PREFIX"
install -m 0644 "$REPO/ScoreForge.html" "$PREFIX/ScoreForge.html"
install -d -m 0755 "$PREFIX/backend"
for f in app.py omr_engine.py preprocess.py requirements.txt; do
    install -m 0644 "$REPO/backend/$f" "$PREFIX/backend/$f"
done
install -d -m 0755 "$PREFIX/fixtures"
# accuracy.json backs the /api/accuracy panel; the images back the test suite.
if [ -d "$REPO/fixtures" ]; then
    install -m 0644 "$REPO/fixtures"/* "$PREFIX/fixtures/" 2>/dev/null || true
fi

# ------------------------------------------------------------------ python env
say "Creating the virtual environment"
"$PYTHON" -m venv "$PREFIX/.venv"
"$PREFIX/.venv/bin/pip" install --quiet --upgrade pip
"$PREFIX/.venv/bin/pip" install --quiet -r "$PREFIX/backend/requirements.txt"

say "Fetching model weights (~37 MB, once)"
# Done here rather than on first request: the service runs with a read-only
# filesystem, and this keeps the first upload from timing out.
"$PREFIX/.venv/bin/python" - <<'PY'
from homr.main import download_weights
download_weights(False, False, False)
from homr.title_detection import download_ocr_weights
download_ocr_weights()
print("    weights ready")
PY

chown -R root:root "$PREFIX"

# --------------------------------------------------------------------- systemd
say "Installing the systemd unit"
install -d -m 0755 "$ETC_DIR"
if [ ! -f "$ETC_DIR/scoreforge.env" ]; then
    install -m 0640 "$ENV_SRC" "$ETC_DIR/scoreforge.env"
    echo "    wrote $ETC_DIR/scoreforge.env (defaults are fine for a local install)"
else
    cp "$ETC_DIR/scoreforge.env" "$ETC_DIR/scoreforge.env.bak"
    echo "    kept your existing $ETC_DIR/scoreforge.env (backed up to .bak)"
fi

sed -e "s#/opt/scoreforge#$PREFIX#g" \
    -e "s#^User=.*#User=$SVC_USER#" \
    -e "s#^Group=.*#Group=$SVC_USER#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=$ETC_DIR/scoreforge.env#" \
    "$UNIT_SRC" > "/etc/systemd/system/scoreforge.service"

systemctl daemon-reload
systemctl enable scoreforge.service >/dev/null
systemctl restart scoreforge.service

say "Waiting for the service"
for _ in $(seq 1 60); do
    port="$(grep -E '^SCOREFORGE_PORT=' "$ETC_DIR/scoreforge.env" 2>/dev/null | cut -d= -f2 || true)"
    port="${port:-8000}"
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

curl -fsS "http://127.0.0.1:${port}/api/health" || {
    systemctl --no-pager --lines 40 status scoreforge.service || true
    die "service did not become healthy"
}

cat <<EOF

$(printf '\033[1m')ScoreForge installed.$(printf '\033[0m')

  page      http://127.0.0.1:${port}/
  API docs  http://127.0.0.1:${port}/api/docs
  install   $PREFIX
  config    $ETC_DIR/scoreforge.env

  systemctl status scoreforge
  journalctl -u scoreforge -f

The page is also a plain file: copy $PREFIX/ScoreForge.html anywhere and
double-click it. It finds the backend on 127.0.0.1:${port}.

To serve it with a static Python server instead:

  $PYTHON -m http.server 8080 --directory $PREFIX --bind 127.0.0.1

Then open http://127.0.0.1:8080/ScoreForge.html. The page tries its own origin
first and falls back to 127.0.0.1:${port} for the API, so scans still work.

$(printf '\033[33m')The service binds loopback and has no authentication.$(printf '\033[0m')
EOF