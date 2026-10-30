#!/usr/bin/env bash

set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TS_DIR="${ROOT_DIR}/ts"
readonly OUTPUT_DIR_INPUT="${1:-artifacts/archflow/phase6}"
readonly RESULTS_DIR_INPUT="${2:-results}"

if [[ "${OUTPUT_DIR_INPUT}" = /* ]]; then
  readonly OUTPUT_DIR="${OUTPUT_DIR_INPUT}"
else
  readonly OUTPUT_DIR="${ROOT_DIR}/${OUTPUT_DIR_INPUT}"
fi
if [[ "${RESULTS_DIR_INPUT}" = /* ]]; then
  readonly RESULTS_DIR="${RESULTS_DIR_INPUT}"
else
  readonly RESULTS_DIR="${ROOT_DIR}/${RESULTS_DIR_INPUT}"
fi

mkdir -p "${OUTPUT_DIR}" "${RESULTS_DIR}"

{
  cd "${TS_DIR}"
  npx nx build archflow-sim
  npx nx test archflow-core --runInBand
  cd "${ROOT_DIR}"
  node scripts/generate_phase6_manifest.mjs \
    ts/scenarios/archflow/phase6-ablation-plan.json \
    "${OUTPUT_DIR}/expanded-manifest.json"
  node ts/dist/packages/archflow-sim/main.js \
    --manifest "${OUTPUT_DIR}/expanded-manifest.json" \
    --output-dir "${OUTPUT_DIR}"
  node scripts/summarize_phase6_ablation.mjs "${OUTPUT_DIR}" "${RESULTS_DIR}"
} 2>&1 | tee "${OUTPUT_DIR}/run.log"
