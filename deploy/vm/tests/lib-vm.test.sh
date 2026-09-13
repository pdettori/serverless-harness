#!/usr/bin/env bash
# Structural + locale-regression tests for deploy/vm/lib-vm.sh. No cluster, no VM, no live run.
#
# Final review fix, round 2, item 1: EPOCHREALTIME (now_ms) and `uptime`'s load average (load1)
# both render with the locale's own radix character, so a comma-radix locale (e.g. de_DE.UTF-8)
# silently corrupts both -- see final-fix-round-2-directive.md item 1 for the original
# reproduction and e8-density.sh's locale-pin comment for the full analysis. This file demands
# proof, not a description: it reproduces the regression itself, then proves the drivers' actual
# fix (LC_ALL=C, not the narrower LC_NUMERIC=C) closes it under the exact scenario the directive
# used (an ambient LC_ALL set to a comma-radix locale).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0
ok() { echo "ok - $1"; }
ko() {
  echo "not ok - $1"
  FAIL=1
}

# shellcheck source=./lib-vm.sh
source ./lib-vm.sh

# --- 0. Find an installed comma-radix locale, or skip the regression checks below. -----------
# A misspelled/unavailable locale name only warns to stderr and falls back to the C locale
# silently, exit 0 -- verified empirically in an earlier session of this same task. So this probe
# must confirm the candidate is ACTUALLY installed (locale -a) before asserting anything against
# it, or these checks would vacuously pass on a locale-less machine/CI image.
#
# Capture `locale -a` once into a variable rather than piping it straight into `grep -q` inside
# the loop: under this file's own `set -o pipefail`, `grep -q` closing the pipe as soon as it
# finds a match sends SIGPIPE back to `locale -a`, and pipefail then reports THAT nonzero exit
# for the whole pipeline even though grep matched -- caught empirically while authoring this
# file: the loop below silently never matched anything until this was changed to grep a captured
# string (via a here-string, so there is no live process on the other end of the pipe to signal).
LOCALES="$(locale -a 2>/dev/null)"
COMMA_LOCALE=""
for cand in de_DE.UTF-8 de_DE fr_FR.UTF-8 fr_FR; do
  if grep -qx "$cand" <<<"$LOCALES"; then
    COMMA_LOCALE="$cand"
    break
  fi
done

if [ -z "$COMMA_LOCALE" ]; then
  echo "# no comma-radix locale installed on this machine (checked de_DE.UTF-8/de_DE/fr_FR.UTF-8/fr_FR); skipping locale regression checks"
else
  # --- 1. The regression is real: EPOCHREALTIME itself renders comma-radix under $COMMA_LOCALE --
  # -- the exact defect final-fix-round-2-directive.md item 1 reproduces via
  # `LC_ALL=de_DE.UTF-8 bash -c 'echo "$EPOCHREALTIME"'`.
  RAW="$(LC_ALL="$COMMA_LOCALE" bash -c 'echo "$EPOCHREALTIME"')"
  case "$RAW" in
  *,*) ok "reproduced the regression: EPOCHREALTIME renders comma-radix under $COMMA_LOCALE ($RAW)" ;;
  *) ko "expected a comma-radix EPOCHREALTIME under $COMMA_LOCALE, got: $RAW" ;;
  esac

  # --- 2. Unpinned now_ms is broken under that locale: its output is NOT a plain integer. ------
  UNPINNED="$(LC_ALL="$COMMA_LOCALE" bash -c 'cd "'"$PWD"'" && source ./lib-vm.sh && now_ms')"
  case "$UNPINNED" in
  '' | *[!0-9]*) ok "confirmed: unpinned now_ms is not a plain integer under $COMMA_LOCALE ($UNPINNED)" ;;
  *) ko "expected unpinned now_ms to be broken under $COMMA_LOCALE, got a clean integer: $UNPINNED" ;;
  esac

  # --- 3. Pinned (LC_ALL=C, exactly what e8-density.sh/e9-tiers.sh export) now_ms IS a plain ----
  # integer even when the ambient environment sets LC_ALL to a comma-radix locale -- this is the
  # directive's own required assertion: "run the helper under a comma-radix locale and assert the
  # result is a plain integer."
  PINNED="$(LC_ALL="$COMMA_LOCALE" bash -c 'export LC_ALL=C && cd "'"$PWD"'" && source ./lib-vm.sh && now_ms')"
  case "$PINNED" in
  '' | *[!0-9]*) ko "pinned now_ms must be a plain integer even under ambient LC_ALL=$COMMA_LOCALE, got: $PINNED" ;;
  *) ok "pinned now_ms is a plain integer under ambient LC_ALL=$COMMA_LOCALE ($PINNED)" ;;
  esac

  # --- 4. Same for load1: pinned output must parse as a plain decimal (or NaN on failure), ------
  # never silently truncate a fractional load average into a misleading whole number via the
  # comma-doubling-as-field-separator bug (uptime's own "6,00" gets read by load1's
  # `awk -F'[, ]+'` as two fields, "6" and "00" -- $1 alone silently drops the fraction).
  PINNED_LOAD1="$(LC_ALL="$COMMA_LOCALE" bash -c 'export LC_ALL=C && cd "'"$PWD"'" && source ./lib-vm.sh && load1')"
  case "$PINNED_LOAD1" in
  NaN) ok "pinned load1 fell back to NaN under ambient LC_ALL=$COMMA_LOCALE (uptime unavailable here)" ;;
  *[0-9].[0-9]*) ok "pinned load1 is a plain decimal under ambient LC_ALL=$COMMA_LOCALE ($PINNED_LOAD1)" ;;
  *) ko "pinned load1 must be a plain decimal or NaN under ambient LC_ALL=$COMMA_LOCALE, got: $PINNED_LOAD1" ;;
  esac

  # --- 5. LC_NUMERIC=C alone (the directive's secondary option) is NOT robust against an --------
  # ambient LC_ALL -- documented here, not only in the driver comments, so a future
  # "simplification" back to the narrower pin fails this test loudly instead of silently
  # regressing. Verified empirically this session: LC_ALL, once present in the environment,
  # overrides LC_NUMERIC for numeric-category resolution regardless of which was exported more
  # recently within the same process.
  NUMERIC_ONLY="$(LC_ALL="$COMMA_LOCALE" bash -c 'export LC_NUMERIC=C && cd "'"$PWD"'" && source ./lib-vm.sh && now_ms')"
  case "$NUMERIC_ONLY" in
  '' | *[!0-9]*)
    ok "confirmed: LC_NUMERIC=C alone does not survive an ambient LC_ALL=$COMMA_LOCALE ($NUMERIC_ONLY) -- this is why the drivers pin LC_ALL=C, not LC_NUMERIC=C"
    ;;
  *)
    ko "expected LC_NUMERIC=C alone to still be broken under ambient LC_ALL=$COMMA_LOCALE; if this now passes, LC_NUMERIC=C may have become sufficient on this platform and the drivers' comments should be revisited (got a clean integer: $NUMERIC_ONLY)"
    ;;
  esac
fi

# --- 6. Structural: both drivers pin LC_ALL=C near their top, before FAIL=0 / any measurement. --
# A future edit that moves or removes the pin should fail here, not on a customer's VM whose
# operator happens to run a comma-radix locale.
for driver in e8-density.sh e9-tiers.sh; do
  PIN_LINE="$(grep -n '^export LC_ALL=C$' "$driver" | head -1 | cut -d: -f1)"
  FAIL0_LINE="$(grep -n '^FAIL=0$' "$driver" | head -1 | cut -d: -f1)"
  if [ -n "$PIN_LINE" ] && [ -n "$FAIL0_LINE" ] && [ "$PIN_LINE" -lt "$FAIL0_LINE" ]; then
    ok "$driver pins LC_ALL=C before FAIL=0 / any measurement"
  else
    ko "$driver must export LC_ALL=C near its top, before any measurement (pin line: '${PIN_LINE:-none}', FAIL=0 line: '${FAIL0_LINE:-none}')"
  fi
done

[ "$FAIL" = 0 ] || exit 1
echo "# lib-vm locale regression tests passed"
