#!/usr/bin/env bash
#
# deploy/install.sh -- install ScoreForge under /opt/scoreforge and run the
# recognition backend as a systemd service.
#
#   sudo ./deploy/install.sh
#
# Override by exporting before running:
#   PREFIX=/opt/scoreforge  SVC_USER=someone  PYTHON=/path/to/python3.12
#   UV_PYTHON_INSTALL_DIR=/opt/python   (where uv-managed interpreters live)
#   PYTHON_VERSION=3.12                 (version uv installs if none is found)
#
# Re-run to upgrade. The install is read-only at runtime; weights are fetched here.
set -Eeuo pipefail
umask 022   # uv/venv inherit this: a 077 root umask makes /opt/python unreadable to SVC_USER

PREFIX="${PREFIX:-/opt/scoreforge}"
SVC_USER="${SVC_USER:-scoreforge}"
PYTHON="${PYTHON:-}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-/opt/python}"
export UV_PYTHON_BIN_DIR="${UV_PYTHON_BIN_DIR:-$UV_PYTHON_INSTALL_DIR/bin}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO/deploy/scoreforge.service"
ENV_SRC="$REPO/deploy/scoreforge.env.example"
ETC_DIR="/etc/scoreforge"
VENV="$PREFIX/.venv"
# requirements.txt pins numpy==2.5.3, which needs Python >= 3.12 (homr itself
# allows 3.11-3.15, so 3.11 passes homr's check but cannot install numpy).
PY_MIN="3.12"; PY_MAX="3.15"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)"
command -v systemctl >/dev/null || die "systemctl not found; this installer is for systemd hosts"
command -v curl >/dev/null || die "curl not found"
[ -f "$REPO/ScoreForge.html" ] || die "ScoreForge.html is not built -- run 'npm install && npm run build' first"
for f in app.py omr_engine.py preprocess.py requirements.txt; do
    [ -f "$REPO/backend/$f" ] || die "missing $REPO/backend/$f"
done
[ -f "$UNIT_SRC" ] && [ -f "$ENV_SRC" ] || die "missing deploy/scoreforge.service or scoreforge.env.example"

# ---------------------------------------------------------------- interpreter
py_ok() {   # py_ok <exe>: runs, and is within PY_MIN..PY_MAX
    "$1" - "$PY_MIN" "$PY_MAX" >/dev/null 2>&1 <<'PY'
import sys
lo, hi = (tuple(map(int, a.split("."))) for a in sys.argv[1:3])
raise SystemExit(0 if lo <= sys.version_info[:2] <= hi else 1)
PY
}

say "Selecting a Python interpreter ($PY_MIN-$PY_MAX)"
if [ -n "$PYTHON" ]; then
    command -v "$PYTHON" >/dev/null || die "PYTHON=$PYTHON not found"
    PYTHON="$(command -v "$PYTHON")"
else
    for c in "python$PYTHON_VERSION" python3.13 python3.12 python3.14 python3.15 python3; do
        if p="$(command -v "$c" 2>/dev/null)" && py_ok "$p"; then PYTHON="$p"; break; fi
    done
fi

if [ -z "$PYTHON" ] || ! py_ok "$PYTHON"; then
    command -v uv >/dev/null || die "no Python $PY_MIN-$PY_MAX found and uv is not installed. Install one (apt install python3.12-venv, or uv) or set PYTHON=/path/to/python"
    say "Installing Python $PYTHON_VERSION with uv into $UV_PYTHON_INSTALL_DIR"
    install -d -m 0755 "$UV_PYTHON_INSTALL_DIR" "$UV_PYTHON_BIN_DIR"
    uv python install "$PYTHON_VERSION"
    PYTHON="$(uv python find "$PYTHON_VERSION")" || die "uv could not locate Python $PYTHON_VERSION"
    py_ok "$PYTHON" || die "$PYTHON is outside $PY_MIN-$PY_MAX"
fi

# Resolve every symlink: the venv's bin/python links to this real file, so the
# real file (and each parent directory) must be reachable by $SVC_USER and must
# not live under /root or /home (the unit sets ProtectHome=true).
PYTHON_REAL="$(readlink -f "$PYTHON")"
PYTHON_HOME="$("$PYTHON_REAL" -c 'import sys; print(sys.base_prefix)')"
echo "    interpreter: $PYTHON_REAL"
echo "    base prefix: $PYTHON_HOME"
case "$PYTHON_HOME" in
    /root/*|/home/*|/tmp/*|/var/tmp/*)
        die "interpreter lives under $PYTHON_HOME, which the service cannot read (ProtectHome/PrivateTmp). Use UV_PYTHON_INSTALL_DIR=/opt/python or a system Python." ;;
esac

# Make a uv-managed tree world-readable/traversable (no-op for system Pythons).
if [ -d "$UV_PYTHON_INSTALL_DIR" ] && [[ "$PYTHON_HOME" == "$UV_PYTHON_INSTALL_DIR"/* ]]; then
    chmod a+rx "$UV_PYTHON_INSTALL_DIR"
    chmod -R a+rX "$UV_PYTHON_INSTALL_DIR"
fi
# Every directory component down to the interpreter must be searchable.
d="$(dirname "$PYTHON_REAL")"
while [ "$d" != "/" ]; do
    [[ "$(stat -c %a "$d")" =~ [1357]$ ]] || chmod o+rx "$d"
    d="$(dirname "$d")"
done
# The venv needs ensurepip/venv; Debian splits it into python3-venv.
"$PYTHON_REAL" -c 'import venv, ensurepip' 2>/dev/null \
    || die "$PYTHON_REAL lacks venv/ensurepip (Debian/Ubuntu: apt install python3-venv)"

# ---------------------------------------------------------------- service user
say "Creating service account $SVC_USER"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
else
    echo "    already exists"
fi

# ------------------------------------------------------------------- copy tree
say "Installing to $PREFIX"
install -d -m 0755 "$PREFIX" "$PREFIX/backend" "$PREFIX/fixtures"
install -m 0644 "$REPO/ScoreForge.html" "$PREFIX/ScoreForge.html"
for f in app.py omr_engine.py preprocess.py requirements.txt; do
    install -m 0644 "$REPO/backend/$f" "$PREFIX/backend/$f"
done
if [ -d "$REPO/fixtures" ]; then
    find "$REPO/fixtures" -maxdepth 1 -type f -exec install -m 0644 {} "$PREFIX/fixtures/" \;
fi

# ------------------------------------------------------------------ python env
say "Creating the virtual environment at $VENV"
# Always rebuild: a venv whose bin/python points at a moved or removed
# interpreter (dangling symlink) cannot be repaired in place.
if [ -e "$VENV" ] || [ -L "$VENV" ]; then
    rm -rf --one-file-system "$VENV"
fi
# A stray venv from the README workflow is never used by the unit; say so.
[ -d "$PREFIX/backend/.venv" ] && warn "$PREFIX/backend/.venv exists but is unused; the service runs $VENV"

"$PYTHON_REAL" -m venv "$VENV"
VPY="$VENV/bin/python"
[ -x "$VPY" ] || die "venv python missing at $VPY"
"$VPY" -c 'import sys; assert sys.prefix != sys.base_prefix' || die "venv was not isolated"
echo "    $VPY -> $(readlink -f "$VPY")"

PIP=("$VPY" -m pip --disable-pip-version-check)
export PIP_NO_CACHE_DIR=1
"${PIP[@]}" install --quiet --upgrade pip wheel packaging

say "Installing dependencies"
REQ="$PREFIX/backend/requirements.txt"
# homr 0.7.0 declares opencv-python-headless<5, while requirements.txt pins 5.0.0.93
# on purpose (homr imports cv2.typing, which only exists in OpenCV 5). pip's resolver
# treats that as a hard conflict (ResolutionImpossible), not the "harmless warning"
# the file's comment describes. So: install everything else first, then homr alone
# with --no-deps; its remaining dependencies are already pinned in the file.
REQ_REST="$(mktemp)"; trap 'rm -f "$REQ_REST"' EXIT
grep -Ev '^[[:space:]]*homr([=<>~! ]|$)' "$REQ" > "$REQ_REST"
HOMR_SPEC="$(grep -E '^[[:space:]]*homr([=<>~! ]|$)' "$REQ" | sed 's/[[:space:]]*#.*//; s/[[:space:]]//g')"
[ -n "$HOMR_SPEC" ] || die "no homr entry in $REQ"

"${PIP[@]}" install --only-binary=:all: -r "$REQ_REST" \
    || die "dependency install failed (numpy==2.5.3 requires Python >= $PY_MIN; this venv is $("$VPY" -V 2>&1))"
# homr's other runtime deps that are not in requirements.txt (read from its metadata).
"${PIP[@]}" install --no-deps "$HOMR_SPEC"
"$VPY" - <<'PY' > "$REQ_REST.homr"
from importlib.metadata import requires
from packaging.requirements import Requirement
skip = {"opencv-python-headless", "numpy", "onnxruntime", "rapidocr", "pillow", "types-pillow"}
for r in requires("homr") or []:
    q = Requirement(r)
    if q.name.lower() not in skip and (q.marker is None or q.marker.evaluate()):
        print(r.split(";")[0].strip())
PY
if [ -s "$REQ_REST.homr" ]; then "${PIP[@]}" install -r "$REQ_REST.homr"; fi
rm -f "$REQ_REST.homr"

say "Verifying the environment"
"$VPY" - <<'PY'
import importlib, sys
for m in ("numpy", "cv2", "cv2.typing", "onnxruntime", "PIL", "pypdfium2",
          "fastapi", "uvicorn", "multipart", "homr.main"):
    importlib.import_module(m)
import numpy, cv2
print(f"    python {sys.version.split()[0]}  numpy {numpy.__version__}  opencv {cv2.__version__}")
PY
"${PIP[@]}" check 2>&1 | sed 's/^/    pip check: /' | grep -v 'opencv-python-headless' || true

say "Fetching model weights (~37 MB, once)"
"$VPY" - <<'PY'
from homr.main import download_weights
download_weights(False, False, False)
from homr.title_detection import download_ocr_weights
download_ocr_weights()
print("    weights ready")
PY

chown -R root:root "$PREFIX"
chmod -R a+rX "$PREFIX"

# The service account must be able to start the interpreter, or systemd reports
# status=203/EXEC (or 200/CHDIR) with no useful message.
say "Checking that $SVC_USER can run the venv"
if command -v runuser >/dev/null; then
    runuser -u "$SVC_USER" -- "$VPY" -c 'import numpy, homr' \
        || die "$SVC_USER cannot run $VPY (check permissions along $(readlink -f "$VPY"))"
fi

# --------------------------------------------------------------------- systemd
say "Installing the systemd unit"
install -d -m 0755 "$ETC_DIR"
if [ ! -f "$ETC_DIR/scoreforge.env" ]; then
    install -m 0640 -g "$SVC_USER" "$ENV_SRC" "$ETC_DIR/scoreforge.env"
    echo "    wrote $ETC_DIR/scoreforge.env"
else
    cp -p "$ETC_DIR/scoreforge.env" "$ETC_DIR/scoreforge.env.bak"
    chgrp "$SVC_USER" "$ETC_DIR/scoreforge.env"; chmod 0640 "$ETC_DIR/scoreforge.env"
    echo "    kept existing $ETC_DIR/scoreforge.env (backup: .bak)"
fi

UNIT_DST="/etc/systemd/system/scoreforge.service"
sed -e "s#/opt/scoreforge#$PREFIX#g" \
    -e "s#^User=.*#User=$SVC_USER#" \
    -e "s#^Group=.*#Group=$SVC_USER#" \
    -e "s#^EnvironmentFile=.*#EnvironmentFile=$ETC_DIR/scoreforge.env#" \
    "$UNIT_SRC" > "$UNIT_DST.tmp"
# ProtectSystem=strict mounts / read-only but leaves the interpreter readable;
# nothing extra is needed unless it lives under /home, which was rejected above.
mv "$UNIT_DST.tmp" "$UNIT_DST"
command -v systemd-analyze >/dev/null && systemd-analyze verify "$UNIT_DST" 2>&1 | sed 's/^/    verify: /' || true

systemctl daemon-reload
systemctl enable scoreforge.service >/dev/null
systemctl restart scoreforge.service

# ------------------------------------------------------------------- health
say "Waiting for the service"
port="$(grep -E '^SCOREFORGE_PORT=' "$ETC_DIR/scoreforge.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]' || true)"
port="${port:-8000}"
healthy=0
for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then healthy=1; break; fi
    systemctl is-failed --quiet scoreforge.service && break
    sleep 1
done
if [ "$healthy" -ne 1 ]; then
    systemctl --no-pager --lines 40 status scoreforge.service || true
    journalctl -u scoreforge --no-pager -n 40 || true
    die "service did not become healthy"
fi
curl -fsS "http://127.0.0.1:$port/api/health"; echo

cat <<MSG

$(printf '\033[1m')ScoreForge installed.$(printf '\033[0m')
  page      http://127.0.0.1:$port/
  API docs  http://127.0.0.1:$port/api/docs
  install   $PREFIX
  python    $PYTHON_REAL
  config    $ETC_DIR/scoreforge.env
  systemctl status scoreforge
  journalctl -u scoreforge -f
$(printf '\033[33m')The service binds loopback and has no authentication.$(printf '\033[0m')
MSG
