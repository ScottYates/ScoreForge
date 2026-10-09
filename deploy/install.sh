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
#   PYTHON_VERSION=3.12                 (version to fetch if none is found)
#   SKIP_WEB=1                          (backend only, no static page service)
#   SKIP_PYTHON_FETCH=1                 (fail instead of fetching a Python)
#   SKIP_SMOKE=0                        (also transcribe a fixture end to end;
#                                        skipped by default -- see below)
#
# The end-to-end transcription check is off by default because it is by far the
# slowest thing here: it runs CPU inference, which is minutes per fixture. Set
# SKIP_SMOKE=0 when recognition itself is what you are installing to verify --
# a first install on a new machine, or after changing the pinned versions.
#
# This never changes the machine's Python. No system package manager is invoked,
# nothing is written to /usr/bin or /usr/local/bin, and no shell profile is
# edited. An interpreter already on PATH is used if it fits the required range;
# otherwise a private one is fetched under $UV_PYTHON_INSTALL_DIR. The system
# python is recorded before and re-checked at the end, and the install fails if
# it moved.
#
# Re-run to upgrade. The install is read-only at runtime; weights are fetched here.
# This script creates users, writes under /opt and drives systemd. Sourcing it
# would do all of that inside your interactive shell, where `set -e`, the ERR
# trap and the umask below would outlive the script -- and the first `exit`
# would close the shell you were sitting in. Run it as a program.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    printf 'error: run this as a program, not with source\n' >&2
    printf '         sudo %s\n' "${BASH_SOURCE[0]}" >&2
    return 1   # not `exit`: that would close the shell the user is sitting in
fi

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
WEB_UNIT_SRC="$REPO/deploy/scoreforge-web.service"
ENV_SRC="$REPO/deploy/scoreforge.env.example"
ETC_DIR="/etc/scoreforge"
VENV="$PREFIX/.venv"
# The page is served from its own directory, never from $PREFIX, which also holds
# backend/*.py and the fixtures.
WEB_ROOT="$PREFIX/www"
DEFAULT_WEB_PORT=8080
SKIP_WEB="${SKIP_WEB:-0}"   # SKIP_WEB=1 installs the backend only
SKIP_PYTHON_FETCH="${SKIP_PYTHON_FETCH:-0}"   # 1 = never download anything
# Inverted default on purpose: SKIP_SMOKE=0 is the opt-*in*. Unlike the other two
# this is the slow step rather than a dangerous one, so the useful default is to
# leave it off -- but it stays available, because it is the only thing in the
# install that proves homr can read a score rather than merely import.
SKIP_SMOKE="${SKIP_SMOKE:-1}"
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
[ -f "$REPO/index.html" ] || die "index.html is not built -- run 'npm install && npm run build' first"
for f in app.py omr_engine.py preprocess.py requirements.txt; do
    [ -f "$REPO/backend/$f" ] || die "missing $REPO/backend/$f"
done
[ -f "$UNIT_SRC" ] && [ -f "$ENV_SRC" ] || die "missing deploy/scoreforge.service or scoreforge.env.example"
[ "$SKIP_WEB" = 1 ] || [ -f "$WEB_UNIT_SRC" ] || die "missing deploy/scoreforge-web.service"

# ---------------------------------------------------------------- interpreter
py_ok() {   # py_ok <exe>: runs, and is within PY_MIN..PY_MAX
    "$1" - "$PY_MIN" "$PY_MAX" >/dev/null 2>&1 <<'PY'
import sys
lo, hi = (tuple(map(int, a.split("."))) for a in sys.argv[1:3])
raise SystemExit(0 if lo <= sys.version_info[:2] <= hi else 1)
PY
}

venv_ok() { "$1" -c 'import venv, ensurepip' >/dev/null 2>&1; }

# What `python3` on this machine resolves to, plus its version. Recorded before
# anything is fetched and re-checked at the end, so an interpreter that quietly
# shadowed or replaced the system one is caught rather than assumed away.
sys_py_snapshot() {
    local p v
    p="$(command -v python3 2>/dev/null || true)"
    [ -n "$p" ] || { printf 'absent'; return; }
    v="$("$p" -c 'import platform; print(platform.python_version())' 2>/dev/null || echo '?')"
    printf '%s %s' "$p" "$v"
}
SYS_PY_BEFORE="$(sys_py_snapshot)"

say "Selecting a Python interpreter ($PY_MIN-$PY_MAX)"
tried=""
if [ -n "$PYTHON" ]; then
    command -v "$PYTHON" >/dev/null || die "PYTHON=$PYTHON not found"
    PYTHON="$(command -v "$PYTHON")"
    py_ok "$PYTHON" || die "PYTHON=$PYTHON is outside $PY_MIN-$PY_MAX"
    venv_ok "$PYTHON" || die "PYTHON=$PYTHON cannot create a venv (Debian splits this into python3-venv)"
else
    for c in "python$PYTHON_VERSION" python3.13 python3.12 python3.14 python3.15 python3; do
        if p="$(command -v "$c" 2>/dev/null)"; then
            if py_ok "$p"; then
                # In range but unable to build a venv is a real case on Debian,
                # where python3-venv is a separate package. Skip it and keep
                # looking: the private-Python path below avoids installing one.
                if venv_ok "$p"; then PYTHON="$p"; break; fi
                tried="$tried\n  $c -> $("$p" -V 2>&1 | head -1)  (no venv/ensurepip)"
            else
                tried="$tried\n  $c -> $("$p" -V 2>&1 | head -1)  (out of range)"
            fi
        fi
    done
fi

if [ -z "$PYTHON" ]; then
    [ -z "$tried" ] || printf '  ignored:\n%b\n' "$tried"
    if [ "$SKIP_PYTHON_FETCH" = 1 ]; then
        die "no Python $PY_MIN-$PY_MAX on this machine, and SKIP_PYTHON_FETCH=1.
  Install one yourself and re-run with PYTHON=/path/to/python, or drop
  SKIP_PYTHON_FETCH to let this script fetch a private copy under $UV_PYTHON_INSTALL_DIR."
    fi
    # uv goes into the isolated tree rather than onto the system, and
    # UV_NO_MODIFY_PATH stops its installer from editing any shell profile.
    if ! command -v uv >/dev/null 2>&1; then
        say "Fetching uv into $UV_PYTHON_BIN_DIR (not installed system-wide)"
        install -d -m 0755 "$UV_PYTHON_BIN_DIR"
        curl -LsSf https://astral.sh/uv/install.sh \
            | env UV_INSTALL_DIR="$UV_PYTHON_BIN_DIR" UV_NO_MODIFY_PATH=1 sh \
            || die "could not fetch uv; install it yourself, or set PYTHON=/path/to/python"
        [ -x "$UV_PYTHON_BIN_DIR/uv" ] || die "uv did not appear at $UV_PYTHON_BIN_DIR/uv"
        PATH="$UV_PYTHON_BIN_DIR:$PATH"; export PATH
    fi
    say "Fetching Python $PYTHON_VERSION into $UV_PYTHON_INSTALL_DIR"
    install -d -m 0755 "$UV_PYTHON_INSTALL_DIR"
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
# The venv needs ensurepip/venv. Nothing in the selection above should reach
# here, but if it does, fail with the non-invasive fix rather than a dead end.
"$PYTHON_REAL" -c 'import venv, ensurepip' 2>/dev/null \
    || die "$PYTHON_REAL lacks venv/ensurepip. Either install your distribution's python3-venv package, or point PYTHON= at an interpreter that has it, or unset SKIP_PYTHON_FETCH so a private one is fetched."

# ---------------------------------------------------------------- service user
say "Creating service account $SVC_USER"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
else
    echo "    already exists"
fi

# ------------------------------------------------------------------- copy tree
say "Installing to $PREFIX"
install -d -m 0755 "$PREFIX" "$PREFIX/backend" "$PREFIX/fixtures" "$WEB_ROOT"
install -m 0644 "$REPO/index.html" "$PREFIX/index.html"
# The web service's document root. Only the built page goes in here, so serving
# this directory cannot leak the backend source or the fixtures.
install -m 0644 "$REPO/index.html" "$WEB_ROOT/index.html"
# The recorded-instrument pack. Both roots need it: the backend serves it from
# its own /pack route, and if the page is served by the web service instead then
# same-origin pack/ has to exist there. Skipped with a warning when absent, so a
# source checkout without the pack still installs -- the sampled instruments
# then fall back to their modelled equivalents.
if [ -d "$REPO/pack" ] && [ -f "$REPO/pack/manifest.json" ]; then
    install -d -m 0755 "$PREFIX/pack" "$WEB_ROOT/pack"
    # Copy the tree, do not flatten it: manifest.json names each sample by its
    # subdirectory ("gpiano/060-0.mp3"), so a flat copy would fetch 404 for
    # every one of them.
    cp -R "$REPO/pack/." "$PREFIX/pack/"
    cp -R "$REPO/pack/." "$WEB_ROOT/pack/"
    find "$PREFIX/pack" "$WEB_ROOT/pack" -type f -exec chmod 0644 {} +
    find "$PREFIX/pack" "$WEB_ROOT/pack" -type d -exec chmod 0755 {} +
    say "Installed the recorded-instrument pack ($(find "$REPO/pack" -type f | wc -l | tr -d ' ') files)"
else
    warn "no pack/ directory -- the recorded instruments will fall back to the synthesiser"
fi
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
# NumPy >= 2.4 wheels need x86-64-v2 (SSE4.2/POPCNT). Virtual CPUs such as QEMU's
# default "qemu64"/"kvm64" lack them and numpy fails at import. Fall back to the
# last 2.3 release (no such baseline). Force either way with NUMPY_SPEC=...
if [ -z "${NUMPY_SPEC:-}" ] && [ "$(uname -m)" = x86_64 ] && ! grep -qw sse4_2 /proc/cpuinfo; then
    NUMPY_SPEC="numpy==2.3.5"
    warn "CPU lacks SSE4.2 (x86-64-v2); using $NUMPY_SPEC instead of the pinned numpy."
    warn "homr declares numpy>=2.4.2, so pip check will report that as a conflict. It is"
    warn "expected here. The end of this install transcribes a real score as the actual"
    warn "test -- but only when SKIP_SMOKE=0, which is off by default, so run it that way"
    warn "if this is a first install and you want the conflict exercised rather than assumed."
fi
if [ -n "${NUMPY_SPEC:-}" ]; then
    sed -i -E "s/^[[:space:]]*numpy[=<>~! ].*/$NUMPY_SPEC/" "$REQ_REST"
    grep -qx "$NUMPY_SPEC" "$REQ_REST" || die "could not apply NUMPY_SPEC=$NUMPY_SPEC"
fi
HOMR_SPEC="$(grep -E '^[[:space:]]*homr([=<>~! ]|$)' "$REQ" | sed 's/[[:space:]]*#.*//; s/[[:space:]]//g')"
[ -n "$HOMR_SPEC" ] || die "no homr entry in $REQ"

"${PIP[@]}" install --prefer-binary -r "$REQ_REST" \
    || die "dependency install failed (numpy==2.5.3 requires Python >= $PY_MIN; this venv is $("$VPY" -V 2>&1))"
# homr's other runtime deps that are not in requirements.txt (read from its metadata).
# types-Pillow is one of these: it is stubs only, but homr declares it as a hard
# requirement, so leaving it out makes `pip check` report a conflict forever.
"${PIP[@]}" install --no-deps "$HOMR_SPEC"
"$VPY" - <<'PY' > "$REQ_REST.homr"
from importlib.metadata import requires
from packaging.requirements import Requirement
skip = {"opencv-python-headless", "numpy", "onnxruntime", "rapidocr", "pillow"}
for r in requires("homr") or []:
    q = Requirement(r)
    if q.name.lower() not in skip and (q.marker is None or q.marker.evaluate()):
        print(r.split(";")[0].strip())
PY
if [ -s "$REQ_REST.homr" ]; then "${PIP[@]}" install -r "$REQ_REST.homr"; fi
rm -f "$REQ_REST.homr"

# rapidocr needs omegaconf >= 2.2 (pathlib.Path support). omegaconf 2.1+ depends on
# an sdist-only package (antlr4-python3-runtime 4.9.*); with --only-binary pip
# silently falls back to omegaconf 2.0.0, which breaks OCR weight download.
"$VPY" - <<'PY' || die "omegaconf is too old; the antlr4 runtime source build probably failed (is build tooling available?)"
from importlib.metadata import version
v = tuple(int(x) for x in version("omegaconf").split(".")[:2])
raise SystemExit(0 if v >= (2, 2) else 1)
PY

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

if [ "$SKIP_WEB" = 1 ]; then
    warn "SKIP_WEB=1: not installing the web service; disabling any existing one"
    systemctl disable --now scoreforge-web.service >/dev/null 2>&1 || true
else
    WEB_UNIT_DST="/etc/systemd/system/scoreforge-web.service"
    sed -e "s#/opt/scoreforge#$PREFIX#g" \
        -e "s#^User=.*#User=$SVC_USER#" \
        -e "s#^Group=.*#Group=$SVC_USER#" \
        -e "s#^EnvironmentFile=.*#EnvironmentFile=$ETC_DIR/scoreforge.env#" \
        "$WEB_UNIT_SRC" > "$WEB_UNIT_DST.tmp"
    mv "$WEB_UNIT_DST.tmp" "$WEB_UNIT_DST"
    command -v systemd-analyze >/dev/null && systemd-analyze verify "$WEB_UNIT_DST" 2>&1 | sed 's/^/    verify: /' || true
fi

systemctl daemon-reload
systemctl enable scoreforge.service >/dev/null
systemctl restart scoreforge.service
if [ "$SKIP_WEB" != 1 ]; then
    systemctl enable scoreforge-web.service >/dev/null
    systemctl restart scoreforge-web.service
fi

# ------------------------------------------------------------------- health
say "Waiting for the service"
port="$(grep -E '^SCOREFORGE_PORT=' "$ETC_DIR/scoreforge.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]' || true)"
port="${port:-8000}"
# The page's own port, if it is served by something other than this service.
webport="$(grep -E '^[[:space:]]*SCOREFORGE_WEB_PORT=' "$ETC_DIR/scoreforge.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
# Same default the web unit falls back to when the env file does not set one.
webport="${webport:-$DEFAULT_WEB_PORT}"
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

# Importing cleanly is not the same as working inference, and the numpy pin above
# is deliberately below what homr declares. So when asked for, measure it:
# transcribe a fixture through the running service and report what came back.
#
# A function rather than an inline `if`, because the block is long and did not
# indent cleanly when wrapped -- and an unindented body inside a conditional is
# how a reader ends up believing the guard covers less than it does.
smoke_test() {
say "Transcribing a test score end to end"
smoke=""
# tiny first: one stave, one bar, four quarter notes inside the stave. It is
# the easiest fixture to read and the easiest to fail meaningfully, so it is
# the one worth spending the check on. The others stay as fallbacks for a
# checkout that predates it.
for f in tiny simple grand; do
    if [ -f "$PREFIX/fixtures/$f.png" ]; then smoke="$PREFIX/fixtures/$f.png"; break; fi
done
[ -n "$smoke" ] || die "no fixture image in $PREFIX/fixtures, so recognition cannot be verified"
notes="$("$VPY" - "$port" "$smoke" <<'PY' 2>/dev/null || true
import json, sys, urllib.request, uuid

port, image = sys.argv[1], sys.argv[2]
boundary = uuid.uuid4().hex
with open(image, "rb") as fh:
    body_bytes = fh.read()
name = image.rsplit("/", 1)[-1]
body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
    "Content-Type: application/octet-stream\r\n\r\n"
).encode() + body_bytes + f"\r\n--{boundary}--\r\n".encode()
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/omr",
    data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)
with urllib.request.urlopen(req, timeout=600) as res:
    print(json.load(res).get("totalNotes", 0))
PY
)"
case "$notes" in
    ''|*[!0-9]*)
        journalctl -u scoreforge --no-pager -n 30 || true
        die "the service is healthy but ${smoke##*/} could not be transcribed"
        ;;
esac
[ "$notes" -gt 0 ] || die "${smoke##*/} transcribed to zero notes"
gt="${smoke%.png}.gt.json"
want=""
if [ -f "$gt" ]; then
    want="$("$VPY" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("renderedNotes",""))' "$gt" 2>/dev/null || true)"
fi
# Anything that is not a plain count cannot be compared against, so treat it as
# unknown rather than letting a string comparison fail confusingly later.
case "$want" in ''|*[!0-9]*) want="" ;; esac
if [ -n "$want" ]; then
    # This was read and printed but never compared, so the check passed on any
    # non-empty transcription -- including one that read the wrong notes. With
    # a four-note fixture the count is the whole score, so it can be asserted.
    [ "$notes" -eq "$want" ] \
        || die "${smoke##*/}: read $notes notes, but the fixture engraves exactly $want"
    echo "    read ${smoke##*/}: $notes notes, matching the fixture exactly"
else
    echo "    read ${smoke##*/}: $notes notes"
fi
}

# Off unless SKIP_SMOKE=0, because CPU inference is minutes per fixture and this
# is by far the slowest thing here. The health check above still proves the
# service imports and serves; what this adds is that homr can actually read a
# score on this machine. So it stays available rather than being deleted -- a
# first install, or a change to the pinned versions, is exactly when you want it.
if [ "$SKIP_SMOKE" != 0 ]; then
    say "Skipping the end-to-end transcription (run with SKIP_SMOKE=0 to include it)"
    smokeline="  recognition  not verified -- re-run the install with SKIP_SMOKE=0"
else
    smoke_test
    smokeline="  recognition  a fixture transcribed end to end"
fi

web_on=1
if [ "$SKIP_WEB" = 1 ]; then
    web_on=0
    webline="  web page  (skipped -- SKIP_WEB=1)"
else
    say "Waiting for the web service on port $webport"
    webup=0
    for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:$webport/" >/dev/null 2>&1; then webup=1; break; fi
        systemctl is-failed --quiet scoreforge-web.service && break
        sleep 1
    done
    if [ "$webup" -ne 1 ]; then
        systemctl --no-pager --lines 20 status scoreforge-web.service || true
        journalctl -u scoreforge-web --no-pager -n 20 || true
        die "the web service did not come up on port $webport"
    fi
    # The document root must stay $WEB_ROOT. If it ever ends up being $PREFIX,
    # this service would hand out backend/*.py and the fixtures over HTTP.
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$webport/backend/app.py" || true)"
    [ "$code" = 404 ] || die "the web service is serving $PREFIX itself: /backend/app.py returned ${code:-no response}, expected 404"
    echo "    page served; /backend/app.py is 404, so only the built file is exposed"
    webline="  web page  http://127.0.0.1:$webport/  (scoreforge-web.service)"
fi
# The promise made in the header comment, checked rather than asserted.
SYS_PY_AFTER="$(sys_py_snapshot)"
[ "$SYS_PY_AFTER" = "$SYS_PY_BEFORE" ] || die "the machine's python3 changed during this install: was [$SYS_PY_BEFORE], now [$SYS_PY_AFTER]"
echo "    machine python3 unchanged: $SYS_PY_AFTER"

apihint="  override     append ?api=http://127.0.0.1:$port to the page URL to point it at this backend"

# What this install actually used, so deploy/release.sh can print the same
# numbers instead of a hardcoded guess. Built from the same two variables as
# the summary below, so the two cannot drift apart.
#
# World-readable on purpose: scoreforge.env is 0640 root:scoreforge, and
# release.sh runs as the invoking user, so it cannot read that one.
state_tmp="$(mktemp)"
cat > "$state_tmp" <<EOF
# Written by deploy/install.sh after a successful install.
# Read by deploy/release.sh to print its summary. Port numbers only -- no
# secrets -- which is why this is world-readable.
SCOREFORGE_PORT=$port
SCOREFORGE_WEB_PORT=$webport
SCOREFORGE_WEB=$web_on
EOF
install -m 0644 "$state_tmp" "$ETC_DIR/installed.env"
rm -f "$state_tmp"

cat <<MSG

$(printf '\033[1m')ScoreForge installed.$(printf '\033[0m')
  page      http://127.0.0.1:$port/
$webline
  API docs  http://127.0.0.1:$port/api/docs
  install   $PREFIX
  python    $PYTHON_REAL
$smokeline
  config    $ETC_DIR/scoreforge.env
  systemctl status scoreforge
  journalctl -u scoreforge -f
$apihint
$(printf '\033[33m')The service binds loopback and has no authentication.$(printf '\033[0m')
MSG
