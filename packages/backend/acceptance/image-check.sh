#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] || exit 2
[[ ${TARGET_ARCH:-} == amd64 || ${TARGET_ARCH:-} == arm64 ]] || exit 2
[[ ${XRPL_ACCEPTANCE_DATABASE:-} == amma_xrpl_acceptance_container ]] || exit 2
: "${XRPL_IMAGE_TAG:?}" "${RUNNER_TEMP:?}"
phase_dir=$(mktemp -d "$RUNNER_TEMP/amma-xrpl-acceptance.XXXXXX")
chmod 755 "$phase_dir"
export XRPL_ACCEPTANCE_ID_FILE="$phase_dir/intent"
node --import tsx acceptance/prepare-container.ts
intent=$(cat "$phase_dir/intent")
[[ $intent =~ ^[a-f0-9-]{36}$ ]] || exit 2
printf 'stall\n' > "$phase_dir/phase"
chmod 644 "$phase_dir/phase"
container="amma-xrpl-acceptance-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${TARGET_ARCH}"
owner="${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}"
cleanup() {
  # Never remove a pre-existing or unrelated container, even on a name collision.
  if [[ $(docker inspect -f '{{ index .Config.Labels "amma.acceptance.run" }}' "$container" 2>/dev/null || true) == "$owner" ]]; then
    docker rm -f "$container" >/dev/null
  fi
}
trap cleanup EXIT
common=(--platform "linux/$TARGET_ARCH" --network host
  --env NODE_ENV=test --env DATABASE_URL --env XRPL_ACCEPTANCE_SANDBOX
  --env XRPL_ACCEPTANCE_DATABASE --env STELLAR_NETWORK=testnet --env XRPL_NETWORK=testnet
  --env JWT_SECRET --env JWT_REFRESH_SECRET --env ADMIN_JWT_SECRET --env SSO_SECRET --env TOTP_ENCRYPTION_KEY)
expected_arch=arm64
if [[ $TARGET_ARCH == amd64 ]]; then expected_arch=x64; fi
# When the image's architecture differs from the runner's, it runs under QEMU emulation.
# amd64 Node under QEMU on ARM64 takes about 8 minutes to start, so give the emulated
# child up to 15 minutes. The checks themselves are unchanged.
host_arch=$(uname -m)
case $host_arch in x86_64) host_arch=amd64 ;; aarch64) host_arch=arm64 ;; esac
claim_wait=30 exit_wait=45s
if [[ $TARGET_ARCH != "$host_arch" ]]; then claim_wait=900 exit_wait=900s; fi
[[ $(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$XRPL_IMAGE_TAG") == "$GITHUB_SHA" ]] || exit 1
[[ $(docker inspect -f '{{.Architecture}}' "$XRPL_IMAGE_TAG") == "$TARGET_ARCH" ]] || exit 1
docker run --rm "${common[@]}" --env "XRPL_ACCEPTANCE_EXPECT_ARCH=$expected_arch" --env XRPL_ENABLED=false --env XRPL_PAYMENTS_ENABLED=false \
  --env XRPL_INTEGRATION_ENABLED=false --env XRPL_RECONCILIATION_ENABLED=false --env XRPL_MONITORING_ENABLED=false \
  --entrypoint node "$XRPL_IMAGE_TAG" --import tsx src/release/runtime-smoke.ts
docker run -d --name "$container" --label "amma.acceptance.run=$owner" "${common[@]}" \
  --mount "type=bind,source=$PWD/acceptance,target=/app/acceptance,readonly" \
  --mount "type=bind,source=$phase_dir,target=/run/acceptance,readonly" \
  --env XRPL_ACCEPTANCE_PHASE_FILE=/run/acceptance/phase --entrypoint node \
  "$XRPL_IMAGE_TAG" --import tsx acceptance/recovery-child.ts "$intent" >/dev/null
claimed=false
for _ in $(seq 1 "$claim_wait"); do
  if docker logs --tail 8 "$container" 2>&1 | grep -Fq 'xrpl_acceptance_lease_claimed'; then claimed=true; break; fi
  sleep 1
done
if [[ $claimed != true ]]; then echo "::error::recovery child did not claim its lease within ${claim_wait}s"; docker logs --tail 20 "$container" 2>&1; exit 1; fi
docker kill --signal=KILL "$container" >/dev/null
[[ $(timeout 15s docker wait "$container") == 137 ]] || exit 1
node --import tsx acceptance/verify-container.ts --expire-lease
printf 'recover\n' > "$phase_dir/phase"
docker start "$container" >/dev/null
[[ $(timeout "$exit_wait" docker wait "$container") == 0 ]] || exit 1
node --import tsx acceptance/verify-container.ts
