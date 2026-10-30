#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [artifactInput, resultsInput] = process.argv.slice(2);
if (!artifactInput || !resultsInput) {
  throw new Error('Usage: node scripts/summarize_phase6_ablation.mjs <artifact-dir> <results-dir>');
}

const artifactDir = path.resolve(artifactInput);
const resultsDir = path.resolve(resultsInput);
const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'experiment-manifest.json'), 'utf8'));
const experimentById = new Map(manifest.experiments.map(experiment => [experiment.id, experiment]));
const outputs = manifest.experiments.map(experiment =>
  JSON.parse(fs.readFileSync(path.join(artifactDir, `${experiment.id}.json`), 'utf8')));
const byCase = new Map();
for (const output of outputs) {
  const key = `${output.workloadId}|${output.deadlineCondition}`;
  if (!byCase.has(key)) byCase.set(key, new Map());
  byCase.get(key).set(output.methodId, output);
}

const references = [
  ['chunkfunc-style-x86', 'savingsVsChunkFuncStyleX86Percent'],
  ['chunkfunc-style-arm64', 'savingsVsChunkFuncStyleArm64Percent'],
  ['archflow-no-architecture-x86', 'savingsVsArchFlowFixedX86Percent'],
  ['archflow-no-architecture-arm64', 'savingsVsArchFlowFixedArm64Percent'],
];
const comparison = (subject, reference) => {
  if (subject.deadlineMet && reference.deadlineMet) {
    return {
      status: 'BOTH_FEASIBLE',
      savings: 100 * (reference.estimatedExecutionCostUsd - subject.estimatedExecutionCostUsd) /
        reference.estimatedExecutionCostUsd,
    };
  }
  if (!subject.deadlineMet && reference.deadlineMet) return { status: 'SUBJECT_INFEASIBLE', savings: '' };
  if (subject.deadlineMet && !reference.deadlineMet) return { status: 'REFERENCE_INFEASIBLE', savings: '' };
  return { status: 'BOTH_INFEASIBLE', savings: '' };
};

const rows = outputs.map(output => {
  const experiment = experimentById.get(output.experimentId);
  const taskCount = output.taskAssignments.length;
  const armCount = output.taskAssignments.filter(item => item.resourceMode.architecture === 'arm64').length;
  const x86Count = taskCount - armCount;
  const modes = [...new Set(output.taskAssignments.map(item => item.resourceMode.id))].sort();
  const caseMethods = byCase.get(`${output.workloadId}|${output.deadlineCondition}`);
  const row = {
    experimentId: output.experimentId,
    workload: output.workloadId,
    workloadCharacteristic: experiment.workloadCharacteristic,
    deadlineCondition: output.deadlineCondition,
    deadlineSeconds: output.deadlineSeconds,
    method: output.methodId,
    methodLabel: experiment.methodLabel,
    schedulerId: output.schedulerId,
    allowArchitectureSelection: output.allowArchitectureSelection ?? '',
    fixedArchitecture: output.fixedArchitecture ?? '',
    estimatedExecutionCostUsd: output.estimatedExecutionCostUsd,
    simulatedMakespanSeconds: output.simulatedMakespanSeconds,
    deadlineMet: output.deadlineMet,
    deadlineViolationSeconds: Math.max(0, output.simulatedMakespanSeconds - output.deadlineSeconds),
    schedulingDecisionOverheadMs: output.schedulingDecisionOverheadMs,
    armTaskPercent: 100 * armCount / taskCount,
    x86TaskPercent: 100 * x86Count / taskCount,
    differentConfigurationsUsed: modes.length,
    selectedConfigurations: JSON.stringify(modes),
    taskAssignments: JSON.stringify(Object.fromEntries(
      output.taskAssignments.map(item => [item.taskId, item.resourceMode.id]))),
  };
  for (const [referenceId, column] of references) {
    const result = comparison(output, caseMethods.get(referenceId));
    row[column] = result.savings;
    row[`${column}Status`] = result.status;
  }
  return row;
});

const csvCell = value => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const columns = Object.keys(rows[0]);
let csv = `${columns.join(',')}\n`;
for (const row of rows) csv += `${columns.map(column => csvCell(row[column])).join(',')}\n`;
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'ablation_results.csv'), csv);

const fullComparisons = [];
for (const [key, methods] of [...byCase.entries()].sort()) {
  const full = methods.get('archflow-full');
  const ablations = [
    methods.get('archflow-no-architecture-x86'),
    methods.get('archflow-no-architecture-arm64'),
  ];
  const feasibleAblations = ablations.filter(item => item.deadlineMet).sort((a, b) =>
    a.estimatedExecutionCostUsd - b.estimatedExecutionCostUsd ||
    a.simulatedMakespanSeconds - b.simulatedMakespanSeconds ||
    a.methodId.localeCompare(b.methodId));
  const best = feasibleAblations[0];
  const controlled = best ? comparison(full, best) : { status: full.deadlineMet ? 'NO_FEASIBLE_ABLATION' : 'ALL_INFEASIBLE', savings: '' };
  fullComparisons.push({ key, full, best, controlled });
}

const fmt = value => typeof value === 'number' ? value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : value;
let markdown = '# Phase 6 ArchFlow-H Ablation Summary\n\n';
markdown += 'The controlled comparison uses the same `ArchFlowHScheduler` for full and no-architecture runs; only candidate architecture filtering changes. Blank savings indicate that the compared pair was not jointly deadline-compliant.\n\n';
markdown += '## Architecture-selection effect\n\n';
markdown += '| Workload | Deadline | Full cost / makespan | Best feasible no-architecture ArchFlow | Ablated cost / makespan | Controlled savings | Status |\n';
markdown += '|---|---:|---:|---|---:|---:|---|\n';
for (const item of fullComparisons) {
  markdown += `| ${item.full.workloadId} (${item.full.deadlineCondition}) | ${item.full.deadlineSeconds} s | ` +
    `$${fmt(item.full.estimatedExecutionCostUsd)} / ${fmt(item.full.simulatedMakespanSeconds)} s | ` +
    `${item.best?.methodId ?? 'None'} | ` +
    `${item.best ? `$${fmt(item.best.estimatedExecutionCostUsd)} / ${fmt(item.best.simulatedMakespanSeconds)} s` : 'N/A'} | ` +
    `${item.controlled.savings === '' ? 'N/A' : `${fmt(item.controlled.savings)}%`} | ${item.controlled.status} |\n`;
}

const positive = fullComparisons.filter(item => typeof item.controlled.savings === 'number' && item.controlled.savings > 1e-9);
const zero = fullComparisons.filter(item => typeof item.controlled.savings === 'number' && Math.abs(item.controlled.savings) <= 1e-9);
const negative = fullComparisons.filter(item => typeof item.controlled.savings === 'number' && item.controlled.savings < -1e-9);
const incomparable = fullComparisons.length - positive.length - zero.length - negative.length;
markdown += `\nObserved controlled architecture-selection effect: positive in ${positive.length}/${fullComparisons.length} cases, zero in ${zero.length}, negative in ${negative.length}, and not comparable in ${incomparable}.\n\n`;
if (positive.length === 0) {
  markdown += '**No additional deadline-compliant cost improvement from architecture selection was observed.** Improvements over ChunkFunc-style baselines therefore arise from the ArchFlow resource-search heuristic in this matrix.\n\n';
}
markdown += '## All runs\n\n';
markdown += '| Workload | Deadline | Method | Cost | Makespan | Met | Violation | ARM | x86 | Configurations | Runtime |\n';
markdown += '|---|---:|---|---:|---:|:---:|---:|---:|---:|---:|---:|\n';
for (const row of rows) {
  markdown += `| ${row.workload} (${row.deadlineCondition}) | ${row.deadlineSeconds} s | ${row.methodLabel} | ` +
    `$${fmt(row.estimatedExecutionCostUsd)} | ${fmt(row.simulatedMakespanSeconds)} s | ` +
    `${row.deadlineMet ? 'Yes' : 'No'} | ${fmt(row.deadlineViolationSeconds)} s | ` +
    `${fmt(row.armTaskPercent)}% | ${fmt(row.x86TaskPercent)}% | ${row.differentConfigurationsUsed} | ` +
    `${fmt(row.schedulingDecisionOverheadMs)} ms |\n`;
}
markdown += '\n## Interpretation limits\n\n';
markdown += '- VidPro x86 values are proxy timings and ARM values are deterministic synthetic derivatives.\n';
markdown += '- The neutral and dominance controls are declared assumptions, not cloud measurements.\n';
markdown += '- Algorithm-runtime measurements are host wall-clock values and are not deterministic metrics.\n';
markdown += '- The greedy heuristic is not claimed to be globally optimal.\n';
fs.writeFileSync(path.join(resultsDir, 'ablation_summary.md'), markdown);

const colors = {
  'chunkfunc-style-x86': '#64748b',
  'chunkfunc-style-arm64': '#94a3b8',
  'archflow-no-architecture-x86': '#f59e0b',
  'archflow-no-architecture-arm64': '#10b981',
  'archflow-full': '#2563eb',
};
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plot(metric, filename, title, deadlineMarkers) {
  const cases = [...byCase.entries()].sort();
  const width = 1500, rowHeight = 150, left = 310, plotWidth = 930, top = 85;
  const height = top + cases.length * rowHeight + 80;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';
  svg += `<text x="30" y="38" font-family="sans-serif" font-size="25" font-weight="700">${escapeXml(title)}</text>`;
  svg += '<text x="30" y="64" font-family="sans-serif" font-size="14" fill="#475569">Hatched bars missed the deadline. Values are modeled; lower is better.</text>';
  svg += '<defs><pattern id="miss" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#991b1b" stroke-width="3"/></pattern></defs>';
  cases.forEach(([key, methods], caseIndex) => {
    const values = [...methods.values()];
    const marker = values[0].deadlineSeconds;
    const maximum = Math.max(...values.map(item => item[metric]), deadlineMarkers ? marker : 0) * 1.12;
    const y0 = top + caseIndex * rowHeight;
    svg += `<text x="25" y="${y0 + 18}" font-family="sans-serif" font-size="15" font-weight="600">${escapeXml(key.replace('|', ' / '))}</text>`;
    values.sort((a, b) => manifest.experiments.findIndex(e => e.id === a.experimentId) - manifest.experiments.findIndex(e => e.id === b.experimentId));
    values.forEach((item, index) => {
      const y = y0 + 28 + index * 21;
      const barWidth = item[metric] / maximum * plotWidth;
      svg += `<text x="${left - 10}" y="${y + 12}" text-anchor="end" font-family="sans-serif" font-size="12">${escapeXml(item.methodId)}</text>`;
      svg += `<rect x="${left}" y="${y}" width="${barWidth}" height="15" fill="${colors[item.methodId]}"/>`;
      if (!item.deadlineMet) svg += `<rect x="${left}" y="${y}" width="${barWidth}" height="15" fill="url(#miss)"/>`;
      svg += `<text x="${left + barWidth + 7}" y="${y + 12}" font-family="sans-serif" font-size="12">${fmt(item[metric])}</text>`;
    });
    if (deadlineMarkers) {
      const x = left + marker / maximum * plotWidth;
      svg += `<line x1="${x}" y1="${y0 + 24}" x2="${x}" y2="${y0 + 135}" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3"/>`;
      svg += `<text x="${x + 4}" y="${y0 + 135}" font-family="sans-serif" font-size="11" fill="#dc2626">deadline ${marker}s</text>`;
    }
    svg += `<line x1="25" y1="${y0 + 143}" x2="1470" y2="${y0 + 143}" stroke="#e2e8f0"/>`;
  });
  svg += '</svg>';
  fs.writeFileSync(path.join(resultsDir, filename), svg);
}
plot('estimatedExecutionCostUsd', 'ablation_cost_comparison.svg', 'Phase 6 modeled execution cost', false);
plot('simulatedMakespanSeconds', 'ablation_makespan_deadline.svg', 'Phase 6 makespan and deadlines', true);

console.log(`Wrote ${rows.length} ablation rows and two SVG plots to ${resultsDir}`);
