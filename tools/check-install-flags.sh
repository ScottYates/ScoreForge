#!/usr/bin/env bash
# Extract install.sh's SKIP_SMOKE dispatch and run it both ways.
#
# deploy/install.sh drives systemd, pip and curl, so it cannot be executed to
# check its branches on a dev box. What *can* be checked is the branch logic
# itself, taken verbatim from the file rather than retyped -- a copied
# conditional would pass while the shipped one was inverted.
set -euo pipefail

SH="${1:-deploy/install.sh}"

# Pull the dispatch block: from the SKIP_SMOKE guard to its closing fi.
# The comparison is matched loosely on purpose. Anchoring on the exact "!=" would
# make an inverted guard fail as "block not found", which is caught but proves
# nothing about behaviour -- the assertions below have to be the thing that fails
# when the sense of the guard changes. Note `.*`, not `[=!]=`: an inverted guard
# writes "= 0", which has one operator, so a pattern expecting "!=" or "=="
# would still miss it.
block="$(sed -n '/^if \[ "\$SKIP_SMOKE".*\]; then$/,/^fi$/p' "$SH")"
[ -n "$block" ] || { echo "FAIL: could not find the SKIP_SMOKE dispatch in $SH"; exit 1; }

default="$(sed -n 's/^SKIP_SMOKE="\${SKIP_SMOKE:-\(.*\)}"$/\1/p' "$SH")"

fails=0
t() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo " FAIL  $1${3:+  -- $3}"; fails=$((fails+1)); fi; }

echo "install.sh: $default is the default for SKIP_SMOKE"

run() {   # $1 = value to set, prints which branch ran
    SKIP_SMOKE="$1"
    say() { printf 'SAY %s\n' "$*"; }
    smoke_test() { echo "RAN smoke_test"; smokeline="  recognition  a fixture transcribed end to end"; }
    eval "$block"
    printf 'LINE %s\n' "$smokeline"
}

out="$(run "$default")"
printf '%s\n' "$out" | grep -q 'SAY Skipping the end-to-end transcription' \
    && t "default ($default) skips the transcription" 1 || t "default ($default) skips the transcription" 0 "$out"
printf '%s\n' "$out" | grep -q 'RAN smoke_test' \
    && t "default does not run the transcription" 0 "it ran" || t "default does not run the transcription" 1
printf '%s\n' "$out" | grep -q 'recognition  not verified' \
    && t "the summary says recognition was not verified" 1 \
    || t "the summary says recognition was not verified" 0 "$out"

out="$(run 0)"
printf '%s\n' "$out" | grep -q 'RAN smoke_test' \
    && t "SKIP_SMOKE=0 runs the transcription" 1 || t "SKIP_SMOKE=0 runs the transcription" 0 "$out"
printf '%s\n' "$out" | grep -q 'SAY Skipping' \
    && t "SKIP_SMOKE=0 does not also print the skip notice" 0 "both ran" \
    || t "SKIP_SMOKE=0 does not also print the skip notice" 1
printf '%s\n' "$out" | grep -q 'recognition  a fixture transcribed end to end' \
    && t "the summary reports the transcription ran" 1 \
    || t "the summary reports the transcription ran" 0 "$out"

# Any other value means skip, matching "unset or 1 skips".
out="$(run banana)"
printf '%s\n' "$out" | grep -q 'SAY Skipping' \
    && t "an unrecognised value skips rather than running" 1 \
    || t "an unrecognised value skips rather than running" 0 "$out"

# The default must not be inherited from the environment by accident.
t "SKIP_SMOKE defaults to skip, so installs stay fast" "$([ "$default" = 1 ] && echo 1 || echo 0)" \
  "default is [$default]"

echo
[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
echo "install flags OK"