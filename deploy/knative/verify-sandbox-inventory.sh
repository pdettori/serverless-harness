#!/usr/bin/env bash
# deploy/knative/verify-sandbox-inventory.sh <image-ref>
#
# Verify a checked-in inventory against the image it describes: every declared binary must
# actually resolve inside the image. Requires docker (or podman, via CONTAINER_RUNTIME) and
# the image.
#
# All declared binaries are checked in a SINGLE container rather than one container per
# binary -- with 347 declared binaries and a ~0.2s container-start cost, one-per-binary would
# take well over a minute per run for no benefit: the check itself (`command -v`) is instant.
#
# The shape test (tests/sandbox-inventory.test.sh) cannot catch drift, because drift is a
# disagreement with reality rather than with the schema.
set -euo pipefail

IMAGE="${1:?usage: verify-sandbox-inventory.sh <image-ref>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sandbox-inventory"
FILE="$DIR/$(printf '%s' "$IMAGE" | tr ':/' '__').json"

[ -f "$FILE" ] || { echo "no inventory for $IMAGE (expected $FILE)"; exit 1; }

RUNTIME="${CONTAINER_RUNTIME:-docker}"
mapfile -t declared < <(jq -r '.binaries[]' "$FILE")
echo "verifying ${#declared[@]} declared binaries in $IMAGE"

# `missing` being non-empty must not itself trip `set -e` via the command substitution, so
# the pipeline's exit status is neutralized with `|| true` and checked explicitly after.
missing="$("$RUNTIME" run --rm --entrypoint sh "$IMAGE" -c '
  for b in "$@"; do command -v "$b" >/dev/null 2>&1 || printf "%s\n" "$b"; done
' sh "${declared[@]}")" || true

if [ -n "$missing" ]; then
  echo "INVENTORY DRIFT: $FILE declares binaries the image does not provide:"
  printf '  %s\n' "$missing"
  echo "Preflight would report these as present and pass a promotion that fails remotely."
  exit 1
fi
echo "PASS: inventory matches $IMAGE"
