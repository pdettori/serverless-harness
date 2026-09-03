#!/usr/bin/env bash
# deploy/knative/tests/sandbox-inventory.test.sh
#
# Shape test for the checked-in sandbox binary inventories. `sh promote` preflights a
# workflow's detected binaries against these files WITHOUT cluster access, so a malformed or
# mis-named file makes preflight quietly wrong -- and a preflight that is quietly wrong is
# worse than none, because people stop checking. This runs on every PR.
#
# Reality (does the image actually provide these?) is verified separately by
# verify-sandbox-inventory.sh, which needs the image and so runs where the image exists.
#
# No cluster required. Run: bash deploy/knative/tests/sandbox-inventory.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/sandbox-inventory"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 (want '$3', got '$2')"; fails=$((fails+1)); fi; }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed (required to validate inventory JSON)"; exit 0; }

shopt -s nullglob
files=("$DIR"/*.json)
if [ ${#files[@]} -eq 0 ]; then echo "FAIL: no inventory files in $DIR"; exit 1; fi

for f in "${files[@]}"; do
  echo "== $(basename "$f")"
  check "valid JSON" "$(jq -e . "$f" >/dev/null 2>&1 && echo yes || echo no)" "yes"
  image="$(jq -r '.image' "$f")"
  expected="$(basename "$f" .json)"
  actual="$(printf '%s' "$image" | tr ':/' '__')"
  check "filename matches .image" "$actual" "$expected"
  check "binaries is a non-empty array" \
    "$(jq -e '(.binaries | type == "array") and (.binaries | length > 0)' "$f" >/dev/null 2>&1 && echo yes || echo no)" "yes"
  check "binaries sorted and unique" \
    "$(jq -r '.binaries == (.binaries | unique)' "$f")" "true"
  # converge.ts and config-overlay.ts both depend on these at run time.
  for required in tar base64 flock git; do
    check "declares '$required' (required by converge/overlay)" \
      "$(jq -r --arg b "$required" '.binaries | index($b) != null' "$f")" "true"
  done
done

if [ "$fails" -ne 0 ]; then echo "FAILED: $fails check(s)"; exit 1; fi
echo "PASS"
