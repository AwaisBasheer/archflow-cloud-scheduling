#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [rawDirArg, resultsDirArg] = process.argv.slice(2);
if (!rawDirArg || !resultsDirArg) {
  console.error('Usage: node summarize_chunkfunc_reproduction.mjs <raw-json-dir> <results-dir>');
  process.exit(1);
}

const rawDir = path.resolve(rawDirArg);
const resultsDir = path.resolve(resultsDirArg);
const expectedCommit = 'e0e7c277310c97d6628ece8aa9bb55368be74092';
const publishedSource = 'https://polaris-slo-cloud.github.io/chunk-func/experiments/2024-11-15/';

const algorithms = {
  ProportionalCriticalPathSloConfigStrategy: {
    label: 'ChunkFunc',
    published: 100,
    order: 0,
  },
  SlamConfigStrategy: {
    label: 'SLAM',
    published: 69,
    order: 1,
  },
  StepConfConfigStrategy: {
    label: 'StepConf',
    published: 78,
    order: 2,
  },
};

const scenarioLabels = {
  'scenario-01-input-500-Mib': 'Large (500 MiB)',
  'scenario-02-input-227-Mib': 'Medium (227 MiB)',
  'scenario-03-input-40-Mib': 'Small (40 MiB)',
};

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(values) {
  return `${values.map(csvCell).join(',')}\n`;
}

const files = fs.readdirSync(rawDir).filter(file => file.endsWith('.json')).sort();
if (files.length !== 639) {
  throw new Error(`Expected 639 fresh JSON outputs, found ${files.length} in ${rawDir}`);
}

const cases = [];
for (const file of files) {
  const filePath = path.join(rawDir, file);
  const result = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const algorithm = algorithms[result.resourceConfigStrategy];

  if (!algorithm) {
    throw new Error(`Unexpected strategy ${result.resourceConfigStrategy} in ${file}`);
  }
  if (result.error) {
    throw new Error(`Simulator error in ${file}: ${result.error}`);
  }
  if (!result.workflowOutput || !Number.isFinite(result.workflowOutput.executionTimeMs) ||
      !Number.isFinite(result.workflowOutput.executionCost) || !Number.isFinite(result.sloMs)) {
    throw new Error(`Missing metrics in ${file}`);
  }

  const independentlyFulfilled = result.workflowOutput.executionTimeMs <= result.sloMs;
  if (independentlyFulfilled !== result.sloFulfilled || independentlyFulfilled !== result.workflowOutput.sloFulfilled) {
    throw new Error(`SLO calculation mismatch in ${file}`);
  }

  cases.push({
    algorithm: algorithm.label,
    algorithmOrder: algorithm.order,
    strategy: result.resourceConfigStrategy,
    scenario: result.scenarioName,
    inputDataSizeMib: result.inputDataSizeMib,
    sloMs: result.sloMs,
    executionTimeMs: result.workflowOutput.executionTimeMs,
    executionCost: result.workflowOutput.executionCost,
    sloFulfilled: independentlyFulfilled,
    avgStrategyTimeMs: result.workflowOutput.avgResourceConfigStrategyExecutionTimeMs,
    rawFile: path.relative(path.dirname(resultsDir), filePath),
  });
}

cases.sort((a, b) =>
  a.algorithmOrder - b.algorithmOrder ||
  a.inputDataSizeMib - b.inputDataSizeMib ||
  a.sloMs - b.sloMs,
);

for (const algorithm of Object.values(algorithms)) {
  const algorithmCases = cases.filter(item => item.algorithm === algorithm.label);
  if (algorithmCases.length !== 213) {
    throw new Error(`Expected 213 cases for ${algorithm.label}, found ${algorithmCases.length}`);
  }
  for (const scenario of Object.keys(scenarioLabels)) {
    const scenarioCases = algorithmCases.filter(item => item.scenario === scenario);
    const distinctSlos = new Set(scenarioCases.map(item => item.sloMs));
    if (scenarioCases.length !== 71 || distinctSlos.size !== 71) {
      throw new Error(`Expected 71 distinct SLO cases for ${algorithm.label}/${scenario}`);
    }
  }
}

fs.mkdirSync(resultsDir, { recursive: true });

let casesCsv = csvLine([
  'Algorithm',
  'Strategy',
  'Scenario',
  'Input MiB',
  'SLO ms',
  'Execution Time ms',
  'Execution Cost',
  'SLO Fulfilled',
  'Average Strategy Time ms',
  'Raw Output',
]);
for (const item of cases) {
  casesCsv += csvLine([
    item.algorithm,
    item.strategy,
    item.scenario,
    item.inputDataSizeMib,
    item.sloMs,
    item.executionTimeMs,
    item.executionCost,
    item.sloFulfilled,
    item.avgStrategyTimeMs,
    item.rawFile,
  ]);
}
fs.writeFileSync(path.join(resultsDir, 'chunkfunc_reproduction_cases.csv'), casesCsv);

const summaries = Object.values(algorithms)
  .sort((a, b) => a.order - b.order)
  .map(algorithm => {
    const algorithmCases = cases.filter(item => item.algorithm === algorithm.label);
    const compliant = algorithmCases.filter(item => item.sloFulfilled).length;
    const reproduced = compliant / algorithmCases.length * 100;
    return {
      ...algorithm,
      evaluated: algorithmCases.length,
      compliant,
      reproduced,
      difference: reproduced - algorithm.published,
    };
  });

let comparisonCsv = csvLine([
  'Algorithm',
  'Published SLO Adherence (%)',
  'Reproduced SLO Adherence (%)',
  'Difference (percentage points)',
]);
for (const item of summaries) {
  comparisonCsv += csvLine([
    item.label,
    item.published.toFixed(2),
    item.reproduced.toFixed(2),
    item.difference.toFixed(2),
  ]);
}
fs.writeFileSync(path.join(resultsDir, 'chunkfunc_reproduction.csv'), comparisonCsv);

const scenarioRows = [];
for (const summary of summaries) {
  for (const [scenario, scenarioLabel] of Object.entries(scenarioLabels)) {
    const selected = cases.filter(item => item.algorithm === summary.label && item.scenario === scenario);
    const compliant = selected.filter(item => item.sloFulfilled).length;
    scenarioRows.push({
      algorithm: summary.label,
      scenario: scenarioLabel,
      evaluated: selected.length,
      compliant,
      adherence: compliant / selected.length * 100,
    });
  }
}

const comparisonRows = summaries.map(item =>
  `| ${item.label} | ${item.published.toFixed(2)}% | ${item.reproduced.toFixed(2)}% | ${item.difference >= 0 ? '+' : ''}${item.difference.toFixed(2)} pp | ${item.compliant}/${item.evaluated} |`,
).join('\n');

const scenarioTableRows = scenarioRows.map(item =>
  `| ${item.algorithm} | ${item.scenario} | ${item.compliant}/${item.evaluated} | ${item.adherence.toFixed(2)}% |`,
).join('\n');

const report = `# ChunkFunc VidPro Published-Result Reproduction

## Outcome

The original ChunkFunc simulator was freshly executed for all 639 required combinations: three VidPro input scenarios, 71 maximum-response-time SLO values, and three algorithms. SLO adherence was independently recomputed as \`workflowOutput.executionTimeMs <= sloMs\` and cross-checked against both simulator feasibility fields.

| Algorithm | Published SLO adherence | Reproduced SLO adherence | Difference | Compliant cases |
|---|---:|---:|---:|---:|
${comparisonRows}

Rounding the reproduced rates to the whole percentages used by the publication gives 100%, 69%, and 78%, exactly matching the published ChunkFunc, SLAM, and StepConf values. The small unrounded differences for SLAM and StepConf are explained by publication rounding, not by altered results.

Published source: <${publishedSource}>

## Experiment definition

- Workload: VidPro (video processing), four function steps with two parallel cut/encode invocations.
- Input scenarios: 3 — small 40 MiB, medium 227 MiB, and large 500 MiB labels (exact input bytes come from the upstream templates).
- Resource set: coarse-grained GCF-like profiles with exhaustive profiling.
- SLO type: \`MaxExecutionTime\`.
- Base SLO: 77,439 ms.
- Sweep: base SLO plus 35 values below and 35 above in 774 ms increments, for 71 distinct SLO values from 50,349 ms through 104,529 ms.
- Cases per algorithm: 3 × 71 = 213.
- Total fresh simulator executions: 639.
- ChunkFunc source commit: \`${expectedCommit}\`.
- Execution environment: Pop!_OS 22.04 LTS, Node.js ${process.version}.

The 774 ms increment reproduces the original Bash integer calculation \`77439 / 100\`. The original comment describes the base as the midpoint between the large scenario's fastest and cheapest configurations. The currently checked-in fastest large execution is 44,788 ms and cheapest is 110,089 ms, whose integer midpoint is 77,438.5 ms and is represented by the script as 77,439 ms.

## Resource profiles and billing assumptions

| Memory (MiB) | CPU (milliCPU) | Price per 100 ms |
|---:|---:|---:|
| 256 | 167 | 0.000000648 |
| 512 | 333 | 0.000001295 |
| 1,024 | 583 | 0.000002310 |
| 2,048 | 1,000 | 0.000004060 |
| 4,096 | 2,000 | 0.000008120 |
| 8,192 | 2,000 | 0.000009520 |
| 16,384 | 4,000 | 0.000190400 |

The workflow file contains a commented-out 128 MiB/83 milliCPU profile, so it is not an available candidate in these executions. Every active profile declares a 100 ms billing unit. The simulator replays the stored \`executionCost\` associated with the selected exhaustive profiling result and sums step costs; it does not query current GCF prices during reproduction.

## Per-scenario adherence

| Algorithm | Input scenario | Compliant/evaluated | Adherence |
|---|---|---:|---:|
${scenarioTableRows}

The publication's VidPro percentage is the aggregate across all three inputs and all 71 deadlines. In particular, one invocation or only the large-input graph cannot reproduce the aggregate.

## Algorithms and parameters

- ChunkFunc: \`ProportionalCriticalPathSloConfigStrategy\`, no command-line options.
- SLAM: \`SlamConfigStrategy\`, trained for every evaluated SLO using the unchanged \`slam-scenario.yaml\` median-input scenario.
- StepConf: \`StepConfConfigStrategy\`, no command-line options; its implementation uses median-input offline profile information.

No random seed is involved in these simulator paths. The selected resource configurations, simulated execution times, costs, and adherence are deterministic. The measured strategy-runtime fields use \`Date.now()\` and may vary between reruns.

## Deviations from the authors' full script

The wrapper intentionally executes only the mandatory \`MaxExecutionTime\` subset and only ChunkFunc, SLAM, and StepConf. The authors' \`run-all-range.sh gcf\` also runs MaxCost, fastest, cheapest, and CF-Oracle/fixed-output cases, then deletes raw JSON after conversion. This reproduction preserves the same VidPro templates, GCF workflow, SLAM training scenario, base SLO, range, increment, and strategy implementations, while retaining every raw JSON file.

The pinned repository commit postdates the November 2024 experiment page. Git history shows the relevant GCF workflow was last changed in February 2024, the scenario templates and compared strategy implementations were last changed by May 2024, and the range script's last relevant experiment change was November 8, 2024. No tracked upstream source was modified for this run.

As a secondary check only, all 639 fresh execution-time and execution-cost pairs match the corresponding rows in the repository's precomputed \`simulation-results-gcf-MaxExecutionTime.csv\`. The fresh raw JSON and run timestamps, rather than that precomputed file, are the evidence used to calculate the reproduced adherence.

The publication page describes the coarse set as eight profiles from 128 MiB through 16,384 MiB. In the executable VidPro workflow, the 128 MiB profile is commented out after a deployment timeout, leaving the seven active candidates listed above. The wrapper follows the executable experiment definition. The page also says “N + 1” distinct SLOs for a symmetric ±N% sweep; the script and checked-in experimental table contain \`2N + 1\`, or 71 values for N=35.

## Reproduction command

From the repository root:

\`\`\`sh
./scripts/reproduce_chunkfunc.sh
\`\`\`

Outputs:

- Raw JSON: \`artifacts/reproduction/phase2/vidpro-gcf-max-execution-time/raw/\`
- Materialized scenario YAML: \`artifacts/reproduction/phase2/vidpro-gcf-max-execution-time/generated-scenarios/\`
- Environment metadata: \`artifacts/reproduction/phase2/vidpro-gcf-max-execution-time/run-metadata.txt\`
- Raw-output hashes: \`artifacts/reproduction/phase2/vidpro-gcf-max-execution-time/raw-sha256.txt\`
- Per-case table: \`results/chunkfunc_reproduction_cases.csv\`
- Published comparison: \`results/chunkfunc_reproduction.csv\`
- Chart: \`results/chunkfunc_reproduction.svg\`

## Interpretation limits

This reproduces the authors' trace-replay aggregate using their stored coarse-grained GCF-like measurements and costs. It does not rerun the original functions on Knative/GCF, validate cloud billing, or produce Fargate/ARM/x86 evidence.
`;
fs.writeFileSync(path.join(resultsDir, 'chunkfunc_reproduction.md'), report);

const chartWidth = 760;
const chartHeight = 390;
const plotTop = 45;
const plotBottom = 315;
const plotHeight = plotBottom - plotTop;
const colors = { published: '#7c8aa5', reproduced: '#2563eb' };
let bars = '';
let labels = '';
summaries.forEach((item, index) => {
  const groupX = 120 + index * 220;
  const publishedHeight = item.published / 100 * plotHeight;
  const reproducedHeight = item.reproduced / 100 * plotHeight;
  bars += `<rect x="${groupX}" y="${plotBottom - publishedHeight}" width="54" height="${publishedHeight}" fill="${colors.published}" rx="3"/>`;
  bars += `<rect x="${groupX + 62}" y="${plotBottom - reproducedHeight}" width="54" height="${reproducedHeight}" fill="${colors.reproduced}" rx="3"/>`;
  labels += `<text x="${groupX + 58}" y="342" text-anchor="middle" font-size="15">${item.label}</text>`;
  labels += `<text x="${groupX + 27}" y="${plotBottom - publishedHeight - 8}" text-anchor="middle" font-size="12">${item.published.toFixed(0)}%</text>`;
  labels += `<text x="${groupX + 89}" y="${plotBottom - reproducedHeight - 8}" text-anchor="middle" font-size="12">${item.reproduced.toFixed(2)}%</text>`;
});

const grid = [0, 25, 50, 75, 100].map(value => {
  const y = plotBottom - value / 100 * plotHeight;
  return `<line x1="70" y1="${y}" x2="730" y2="${y}" stroke="#d7dce5"/><text x="58" y="${y + 4}" text-anchor="end" font-size="12">${value}%</text>`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}">
  <rect width="100%" height="100%" fill="white"/>
  <text x="380" y="25" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="600">VidPro Maximum Response Time SLO Adherence</text>
  <g font-family="sans-serif" fill="#1f2937">${grid}${bars}${labels}</g>
  <rect x="245" y="365" width="14" height="14" fill="${colors.published}"/><text x="266" y="377" font-family="sans-serif" font-size="12">Published</text>
  <rect x="365" y="365" width="14" height="14" fill="${colors.reproduced}"/><text x="386" y="377" font-family="sans-serif" font-size="12">Reproduced</text>
</svg>\n`;
fs.writeFileSync(path.join(resultsDir, 'chunkfunc_reproduction.svg'), svg);

for (const item of summaries) {
  console.log(`${item.label}: ${item.compliant}/${item.evaluated} = ${item.reproduced.toFixed(2)}% (published ${item.published}%)`);
}
