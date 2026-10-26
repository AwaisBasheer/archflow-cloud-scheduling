#!/usr/bin/env bash

set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TS_DIR="${ROOT_DIR}/ts"
readonly OUTPUT_DIR_INPUT="${1:-artifacts/archflow/phase5}"

if [[ "${OUTPUT_DIR_INPUT}" = /* ]]; then
  readonly OUTPUT_DIR="${OUTPUT_DIR_INPUT}"
else
  readonly OUTPUT_DIR="${ROOT_DIR}/${OUTPUT_DIR_INPUT}"
fi

mkdir -p "${OUTPUT_DIR}"

{
  cd "${TS_DIR}"
  npx nx build archflow-sim
  npx nx test archflow-core --runInBand
  node ./dist/packages/archflow-sim/main.js \
    --manifest scenarios/archflow/phase5-experiments.json \
    --output-dir "${OUTPUT_DIR}"
} 2>&1 | tee "${OUTPUT_DIR}/run.log"
