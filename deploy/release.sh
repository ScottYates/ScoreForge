#!/usr/bin/env bash
#
# deploy/release.sh -- build the page and install it, in one step.
#
#   ./deploy/release.sh
#
# The same three commands the README lists, with the failure modes handled:
#
#   npm ci                  exact install from the committed lockfile
#   npm run build           writes index.html
#   sudo deploy/install.sh  /opt, a system user, systemd, model weights
#
# Everything is idempotent, so this is also the upgrade path: pull and re-run.
#
# Overrides by exporting before running:
#   SKIP_NPM=1              only run the installer
#   SKIP_INSTALL=1          only build
#   NPM_INSTALL=1           use `npm install` instead of `npm ci`
#   PYTHON_VERSION=3.13     interpreter to fetch if the host has none in range

# Builds and installs a system service; sourcing it would do that inside your
# shell and close it on the first error. Run it as a program.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    printf 'error: run this as a program, not with source\n' >&2
    printf '         %s\n' "${BASH_SOURCE[0]}" >&2
    return 1
fi

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

SKIP_NPM="${SKIP_NPM:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
NPM_INSTALL="${NPM_INSTALL:-0}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

# The install step needs root. It is invoked with sudo rather than by running
# this whole script as root, because `npm ci` as root leaves node_modules owned
# by root and the next non-root build fails in confusing ways. If someone does
# run this whole script under sudo, drop back to the invoking user for npm.
as_owner() {
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
        sudo -u "$SUDO_USER" -H -- "$@"
    else
        "$@"
    fi
}

# Tolerant on purpose: a node that prints something unexpected must fall
# through to the explicit check below, not trip `set -e` inside the pipeline and
# report a cut/sed failure instead of the real problem.
node_major() {
    local v
    v="$(node --version 2>/dev/null || true)"
    v="${v#v}"
    case "$v" in
        [0-9]*.*) printf '%s' "${v%%.*}" ;;
        *) printf '' ;;
    esac
}

# ------------------------------------------------------------------ preflight
[ -f package.json ] || die "package.json not found; run this from a ScoreForge checkout"

if [ "$SKIP_NPM" != 1 ]; then
    command -v node >/dev/null || die "node not found. Install Node 18 or newer: https://nodejs.org"
    command -v npm  >/dev/null || die "npm not found; it normally ships with node"
    major="$(node_major)"
    [ -n "$major" ] || die "could not read the node version"
    # import.meta.dirname needs 20.11, but the build itself only needs 18. The
    # browser-driven tests need 22; warn rather than block, since they are not
    # part of this script.
    [ "$major" -ge 18 ] || die "node $major is too old; the build needs 18 or newer"
    if [ "$major" -lt 22 ]; then
        # Escaped backticks on purpose. Unescaped, they are command
        # substitution: the warning would run npm test, and on Node 18 that
        # fails, which aborts the release this message was meant to describe.
        warn "node $major builds fine, but \`npm test\` needs 22 or newer (global WebSocket)."
    fi
    echo "    node $(node --version)  npm v$(npm --version)"
fi

# ------------------------------------------------------------------- the npm
if [ "$SKIP_NPM" != 1 ]; then
    if [ "$NPM_INSTALL" = 1 ]; then
        say "npm install"
        as_owner npm install
    else
        say "npm ci (exact install from package-lock.json)"
        as_owner npm ci
    fi

    say "npm run build"
    as_owner npm run build
    [ -f index.html ] || die "the build reported success but index.html is not there"
    echo "    index.html  $(stat -c%s index.html) bytes"
fi

# ------------------------------------------------------------------ the install
if [ "$SKIP_INSTALL" != 1 ]; then
    say "deploy/install.sh"
    [ -x deploy/install.sh ] || die "deploy/install.sh is not executable (chmod +x it)"
    if [ "$(id -u)" -eq 0 ]; then
        deploy/install.sh
    elif command -v sudo >/dev/null; then
        sudo ./deploy/install.sh
    else
        die "installing needs root and sudo is not available; run: su -c '$(pwd)/deploy/install.sh'"
    fi
    # install.sh ends with its own checks -- it transcribes a fixture and proves
    # the web document root is not exposing the source tree -- so reaching here
    # means those passed.
fi

say "Done"
# The ports are whatever the last install resolved, which is not always 8080
# and 8000 -- scoreforge.env can name any of them. They are read back from the
# record install.sh left, rather than restated here, so the two summaries
# cannot disagree.
INSTALL_STATE=/etc/scoreforge/installed.env

state_get() {   # state_get KEY -- value, or empty if the key is absent
    grep -E "^$1=" "$INSTALL_STATE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true
}

if [ "$SKIP_INSTALL" = 1 ]; then
    echo "  install skipped (SKIP_INSTALL=1)"
elif [ -r "$INSTALL_STATE" ]; then
    api_port="$(state_get SCOREFORGE_PORT)"
    web_port="$(state_get SCOREFORGE_WEB_PORT)"
    web_on="$(state_get SCOREFORGE_WEB)"
    if [ -n "$api_port" ]; then
        echo "  page      http://127.0.0.1:$api_port/     (scoreforge.service)"
        echo "  API docs  http://127.0.0.1:$api_port/api/docs"
        if [ "$web_on" = 1 ] && [ -n "$web_port" ]; then
            echo "  web page  http://127.0.0.1:$web_port/     (scoreforge-web.service)"
        fi
    else
        warn "$INSTALL_STATE has no SCOREFORGE_PORT; not printing URLs."
    fi
    echo "  status    systemctl status scoreforge scoreforge-web"
else
    warn "$INSTALL_STATE is missing or unreadable, so the ports are unknown here."
    echo "  the summary printed by deploy/install.sh above has them"
fi