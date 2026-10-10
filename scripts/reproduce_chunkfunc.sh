#!/usr/bin/env bash

set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TS_DIR="${ROOT_DIR}/ts"
readonly SCENARIO_DIR="${TS_DIR}/scenarios/video-processing"
readonly SIMULATOR="${TS_DIR}/dist/packages/chunk-func-sim/main.js"
readonly WORKFLOW="${SCENARIO_DIR}/workflow-gcf.yaml"
readonly SLAM_TRAINING_SCENARIO="${SCENARIO_DIR}/slam-scenario.yaml"
readonly OUTPUT_DIR="${1:-${ROOT_DIR}/artifacts/reproduction/phase2/vidpro-gcf-max-execution-time}"
readonly RAW_DIR="${OUTPUT_DIR}/raw"
readonly GENERATED_SCENARIO_DIR="${OUTPUT_DIR}/generated-scenarios"
readonly EXPECTED_COMMIT="e0e7c277310c97d6628ece8aa9bb55368be74092"
readonly BASE_SLO=77439
readonly SLO_RANGE_PERCENT=35
readonly SLO_STEP_PERCENT=1

readonly SCENARIOS=(
  "scenario-01"
  "scenario-02"
  "scenario-03"
)

readonly STRATEGY_KEYS=(
  "chunkfunc"
  "slam"
  "stepconf"
)

for dependency in bash bc sed node npm npx git; do
  if ! command -v "${dependency}" >/dev/null 2>&1; then
    echo "Missing required command: ${dependency}" >&2
    exit 1
  fi
done

actual_commit="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
if ! git -C "${ROOT_DIR}" merge-base --is-ancestor "${EXPECTED_COMMIT}" HEAD; then
  echo "Workspace commit ${actual_commit} does not descend from ChunkFunc ${EXPECTED_COMMIT}." >&2
  exit 1
fi
if ! git -C "${ROOT_DIR}" diff --quiet "${EXPECTED_COMMIT}" -- \
  ts/packages/core ts/packages/chunk-func-sim ts/packages/results-converter \
  ts/scenarios/video-processing docs/workflow-optimizer.md; then
  echo "Original ChunkFunc implementation or VidPro inputs differ from ${EXPECTED_COMMIT}." >&2
  exit 1
fi

mkdir -p "${RAW_DIR}" "${GENERATED_SCENARIO_DIR}" "${ROOT_DIR}/results"

echo "Building original ChunkFunc simulator and result converter..."
(
  cd "${TS_DIR}"
  npx nx build chunk-func-sim
  npx nx build results-converter
)

cat > "${OUTPUT_DIR}/run-metadata.txt" <<EOF
experiment=VidPro coarse-grained GCF-like profiles, exhaustive profiling, MaxExecutionTime
started_at=$(TZ=Asia/Karachi date --iso-8601=seconds)
chunkfunc_commit=${EXPECTED_COMMIT}
workspace_commit=${actual_commit}
node=$(node --version)
npm=$(npm --version)
nx=$(cd "${TS_DIR}" && npx nx --version | sed -n 's/^- Local: //p')
base_slo_ms=${BASE_SLO}
slo_range_percent=${SLO_RANGE_PERCENT}
slo_step_percent=${SLO_STEP_PERCENT}
workflow=${WORKFLOW}
slam_training_scenario=${SLAM_TRAINING_SCENARIO}
EOF

declare -a slo_values=("${BASE_SLO}")
one_percent=$((BASE_SLO / 100))

for ((i = SLO_STEP_PERCENT; i <= SLO_RANGE_PERCENT; i += SLO_STEP_PERCENT)); do
  slo_values+=("$((BASE_SLO - one_percent * i))")
done
for ((i = SLO_STEP_PERCENT; i <= SLO_RANGE_PERCENT; i += SLO_STEP_PERCENT)); do
  slo_values+=("$((BASE_SLO + one_percent * i))")
done

if [[ "${#slo_values[@]}" -ne 71 ]]; then
  echo "Internal error: expected 71 SLO values, got ${#slo_values[@]}." >&2
  exit 1
fi

run_strategy() {
  local strategy_key=$1
  local scenario_name=$2
  local scenario_path=$3
  local slo_limit=$4
  local strategy_name=""
  local output_path="${RAW_DIR}/${scenario_name}-${strategy_key}-${slo_limit}.json"
  local temporary_output="${output_path}.tmp"

  case "${strategy_key}" in
    chunkfunc)
      strategy_name="ProportionalCriticalPathSloConfigStrategy"
      node "${SIMULATOR}" "${WORKFLOW}" "${scenario_path}" "${strategy_name}" > "${temporary_output}"
      ;;
    slam)
      strategy_name="SlamConfigStrategy"
      node "${SIMULATOR}" "${WORKFLOW}" "${scenario_path}" "${strategy_name}" "${SLAM_TRAINING_SCENARIO}" > "${temporary_output}"
      ;;
    stepconf)
      strategy_name="StepConfConfigStrategy"
      node "${SIMULATOR}" "${WORKFLOW}" "${scenario_path}" "${strategy_name}" > "${temporary_output}"
      ;;
    *)
      echo "Unknown strategy key: ${strategy_key}" >&2
      exit 1
      ;;
  esac

  node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (result.error || !result.workflowOutput || result.workflowOutput.executionTimeMs < 0) {
      throw new Error(`Invalid simulator result in ${process.argv[1]}: ${result.error || "missing metrics"}`);
    }
  ' "${temporary_output}"
  mv "${temporary_output}" "${output_path}"
}

echo "Executing 3 scenarios x 71 SLOs x 3 strategies = 639 simulations..."
for scenario_name in "${SCENARIOS[@]}"; do
  template_path="${SCENARIO_DIR}/${scenario_name}-template.yaml"
  scenario_output_dir="${GENERATED_SCENARIO_DIR}/${scenario_name}"
  mkdir -p "${scenario_output_dir}"

  completed_slos=0
  for slo_limit in "${slo_values[@]}"; do
    scenario_path="${scenario_output_dir}/${scenario_name}-${slo_limit}.yaml"
    sed \
      -e "s/{{ \.sloType }}/MaxExecutionTime/" \
      -e "s/{{ \.sloLimit }}/${slo_limit}/" \
      "${template_path}" > "${scenario_path}"

    for strategy_key in "${STRATEGY_KEYS[@]}"; do
      run_strategy "${strategy_key}" "${scenario_name}" "${scenario_path}" "${slo_limit}"
    done

    completed_slos=$((completed_slos + 1))
    if ((completed_slos % 10 == 0 || completed_slos == 71)); then
      echo "${scenario_name}: ${completed_slos}/71 SLO values complete"
    fi
  done
done

node "${ROOT_DIR}/scripts/summarize_chunkfunc_reproduction.mjs" \
  "${RAW_DIR}" \
  "${ROOT_DIR}/results"

printf 'completed_at=%s\n' "$(TZ=Asia/Karachi date --iso-8601=seconds)" >> "${OUTPUT_DIR}/run-metadata.txt"

echo "Raw outputs: ${RAW_DIR}"
echo "Comparison: ${ROOT_DIR}/results/chunkfunc_reproduction.csv"
echo "Report: ${ROOT_DIR}/results/chunkfunc_reproduction.md"
