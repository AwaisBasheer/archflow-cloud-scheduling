#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const rawPath = path.join(root, 'artifacts/archflow/aws/final/raw/final-evaluation-all.json');
const plansDir = path.join(root, 'artifacts/archflow/aws/final/plans');
const profilePath = path.join(root, 'artifacts/archflow/aws/profiles/measured-ffmpeg-task-matrix.json');
const pricingPath = path.join(root, 'artifacts/archflow/aws/configurations/pricing-snapshot.json');
const outDir = path.join(root, 'artifacts/archflow/aws/final/results');
const figDir = path.join(outDir, 'figures');

for (const directory of [outDir, figDir]) fs.mkdirSync(directory, { recursive: true });

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const pricing = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
const planFiles = {
  'chunkfunc-x86': 'chunkfunc-x86.json',
  'chunkfunc-arm': 'chunkfunc-arm.json',
  'archflow-fixed-x86': 'archflow-fixed-x86.json',
  'archflow-fixed-arm': 'archflow-fixed-arm.json',
  'archflow-full': 'archflow-full.json',
};
const plans = Object.fromEntries(Object.entries(planFiles).map(([method, file]) => [method, JSON.parse(fs.readFileSync(path.join(plansDir, file), 'utf8'))]));

const isoMs = value => value ? Date.parse(value) : null;
const seconds = (start, end) => (isoMs(end) - isoMs(start)) / 1000;
const tagMap = task => Object.fromEntries((task.tags ?? []).map(tag => [tag.key, tag.value]));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sampleStdDev = values => values.length < 2 ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1));
const round = (value, digits = 9) => value == null ? null : Number(value.toFixed(digits));
const csvCell = value => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const writeCsv = (file, rows, columns) => {
  const lines = [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))];
  fs.writeFileSync(path.join(outDir, file), `${lines.join('\n')}\n`);
};

const ratePerSecond = architecture => architecture === 'ARM64'
  ? { cpu: pricing.rates.armVCpuHour / 3600, memory: pricing.rates.armMemoryGbHour / 3600 }
  : { cpu: pricing.rates.x86VCpuHour / 3600, memory: pricing.rates.x86MemoryGbHour / 3600 };

const parseLog = record => {
  const parsed = [];
  for (const event of record.workerLogEvents ?? []) {
    try { parsed.push(JSON.parse(event.message)); } catch { /* Retain raw logs; ignore non-JSON for metrics. */ }
  }
  return parsed;
};

const allTasks = raw.tasks.map(record => {
  const task = record.task;
  const tags = tagMap(task);
  const logs = parseLog(record);
  const applicationStart = logs.find(event => event.event === 'archflow_application_start')?.timestamp ?? null;
  const applicationEnd = logs.find(event => event.event === 'archflow_application_end')?.timestamp ?? null;
  const runtime = logs.find(event => event.event === 'archflow_runtime') ?? {};
  const validation = logs.find(event => event.event === 'archflow_output_validated') ?? {};
  const successful = task.stopCode === 'EssentialContainerExited'
    && task.containers?.length === 3
    && task.containers.every(container => container.exitCode === 0);
  const architecture = tags.Architecture;
  const vCpu = Number(task.cpu) / 1024;
  const memoryGb = Number(task.memory) / 1024;
  const fullLifecycleSeconds = task.createdAt && task.stoppedAt ? seconds(task.createdAt, task.stoppedAt) : null;
  const providerMeteredSeconds = task.pullStartedAt && task.stoppedAt ? seconds(task.pullStartedAt, task.stoppedAt) : null;
  const billableSeconds = providerMeteredSeconds == null ? null : Math.ceil(Math.max(pricing.linuxMinimumBillableSeconds, providerMeteredSeconds));
  const rates = ratePerSecond(architecture);
  const computeMemoryUsd = billableSeconds == null ? null : billableSeconds * (vCpu * rates.cpu + memoryGb * rates.memory);
  const publicIpv4Usd = fullLifecycleSeconds == null ? null : fullLifecycleSeconds * pricing.rates.publicIpv4Hour / 3600;
  const costUsd = computeMemoryUsd == null || publicIpv4Usd == null ? null : computeMemoryUsd + publicIpv4Usd;
  const taskClass = tags.TaskClass;
  const nodeId = taskClass === 'cut' ? `cut-${tags.Branch}` : taskClass;
  return {
    taskArn: task.taskArn,
    taskId: task.taskArn.split('/').at(-1),
    runId: tags.RunId,
    method: tags.Method,
    repetition: Number(tags.Repetition ?? '1'),
    nodeId,
    taskClass,
    branch: tags.Branch ?? '',
    architecture,
    actualArchitecture: runtime.architecture ?? null,
    mode: tags.Mode,
    vCpu,
    memoryGb,
    createdAt: task.createdAt ?? null,
    pullStartedAt: task.pullStartedAt ?? null,
    pullStoppedAt: task.pullStoppedAt ?? null,
    startedAt: task.startedAt ?? null,
    stoppedAt: task.stoppedAt ?? null,
    stopCode: task.stopCode ?? null,
    stoppedReason: task.stoppedReason ?? null,
    successful,
    applicationSeconds: applicationStart && applicationEnd ? seconds(applicationStart, applicationEnd) : null,
    imagePullSeconds: task.pullStartedAt && task.pullStoppedAt ? seconds(task.pullStartedAt, task.pullStoppedAt) : null,
    fullLifecycleSeconds,
    providerMeteredSeconds,
    billableSeconds,
    computeMemoryUsd,
    publicIpv4Usd,
    costUsd,
    outputBytes: validation.sizeBytes ?? null,
    outputSha256: validation.sha256 ?? null,
    outputObjectKey: validation.objectKey ?? null,
    attempt: tags.Attempt ?? '1',
  };
});

const successfulTasks = allTasks.filter(task => task.successful);
const failures = allTasks.filter(task => !task.successful);
const groupedRuns = Map.groupBy(successfulTasks, task => task.runId);
const workflowRows = [];

for (const [runId, tasks] of [...groupedRuns.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (tasks.length !== 5) throw new Error(`${runId}: expected 5 successful task nodes, found ${tasks.length}`);
  const byNode = Object.fromEntries(tasks.map(task => [task.nodeId, task]));
  for (const node of ['generate-source', 'cut-a', 'cut-b', 'merge', 'validate']) {
    if (!byNode[node]) throw new Error(`${runId}: missing successful ${node}`);
  }
  const method = tasks[0].method;
  const plan = plans[method];
  const observedStartMs = Math.min(...tasks.map(task => isoMs(task.createdAt)));
  const observedEndMs = isoMs(byNode.validate.stoppedAt);
  const observedWallMakespanSeconds = (observedEndMs - observedStartMs) / 1000;
  const dependencyNormalizedMakespanSeconds = byNode['generate-source'].fullLifecycleSeconds
    + Math.max(byNode['cut-a'].fullLifecycleSeconds, byNode['cut-b'].fullLifecycleSeconds)
    + byNode.merge.fullLifecycleSeconds
    + byNode.validate.fullLifecycleSeconds;
  const costUsd = tasks.reduce((sum, task) => sum + task.costUsd, 0);
  const armTasks = tasks.filter(task => task.architecture === 'ARM64').length;
  const x86Tasks = tasks.filter(task => task.architecture === 'X86_64').length;
  workflowRows.push({
    runId,
    method,
    repetition: tasks[0].repetition,
    taskCount: tasks.length,
    architectures: [...new Set(tasks.map(task => task.architecture))].sort().join('+'),
    armTaskCount: armTasks,
    x86TaskCount: x86Tasks,
    armPercent: round(armTasks / tasks.length * 100, 3),
    x86Percent: round(x86Tasks / tasks.length * 100, 3),
    distinctConfigurations: new Set(tasks.map(task => `${task.architecture}:${task.vCpu}:${task.memoryGb}`)).size,
    deadlineSeconds: plan.deadlineSeconds,
    predictedMakespanSeconds: plan.schedule.simulatedMakespanSeconds,
    predictedComputeMemoryCostUsd: plan.schedule.estimatedExecutionCostUsd,
    observedWallMakespanSeconds: round(observedWallMakespanSeconds, 6),
    observedWallDeadlineMet: observedWallMakespanSeconds <= plan.deadlineSeconds,
    dependencyNormalizedMakespanSeconds: round(dependencyNormalizedMakespanSeconds, 6),
    dependencyNormalizedDeadlineMet: dependencyNormalizedMakespanSeconds <= plan.deadlineSeconds,
    estimatedProviderCostUsd: round(costUsd, 12),
    schedulingDecisionOverheadMs: plan.schedule.schedulingDecisionOverheadMs,
    successful: true,
  });
}

const workflowByRun = Object.fromEntries(workflowRows.map(row => [row.runId, row]));
const predictionRows = [];
for (const task of successfulTasks) {
  const plan = plans[task.method];
  const assignment = plan.schedule.taskAssignments.find(item => item.taskId === task.nodeId);
  if (!assignment) throw new Error(`${task.runId}/${task.nodeId}: no plan assignment`);
  predictionRows.push({
    runId: task.runId,
    method: task.method,
    repetition: task.repetition,
    nodeId: task.nodeId,
    taskClass: task.taskClass,
    architecture: task.architecture,
    resourceModeId: assignment.resourceMode.id,
    predictedApplicationSeconds: assignment.executionSeconds,
    measuredApplicationSeconds: round(task.applicationSeconds, 6),
    applicationAbsoluteErrorSeconds: round(Math.abs(task.applicationSeconds - assignment.executionSeconds), 6),
    applicationAbsolutePercentageError: round(Math.abs(task.applicationSeconds - assignment.executionSeconds) / task.applicationSeconds * 100, 6),
    predictedLifecycleSeconds: assignment.simulatedDurationSeconds,
    measuredLifecycleSeconds: round(task.fullLifecycleSeconds, 6),
    lifecycleAbsoluteErrorSeconds: round(Math.abs(task.fullLifecycleSeconds - assignment.simulatedDurationSeconds), 6),
    lifecycleAbsolutePercentageError: round(Math.abs(task.fullLifecycleSeconds - assignment.simulatedDurationSeconds) / task.fullLifecycleSeconds * 100, 6),
  });
}

const methodSummaries = [...Map.groupBy(workflowRows, row => row.method).entries()].map(([method, rows]) => {
  const costs = rows.map(row => row.estimatedProviderCostUsd);
  const normalized = rows.map(row => row.dependencyNormalizedMakespanSeconds);
  const observed = rows.map(row => row.observedWallMakespanSeconds);
  return {
    method,
    repetitions: rows.length,
    architecturePolicy: method === 'archflow-full' ? 'joint (selected ARM64 for every task)' : method.includes('x86') ? 'fixed X86_64' : 'fixed ARM64',
    meanCostUsd: round(mean(costs), 12),
    medianCostUsd: round(median(costs), 12),
    costSampleStdDevUsd: round(sampleStdDev(costs), 12),
    meanDependencyNormalizedMakespanSeconds: round(mean(normalized), 6),
    medianDependencyNormalizedMakespanSeconds: round(median(normalized), 6),
    normalizedMakespanSampleStdDevSeconds: round(sampleStdDev(normalized), 6),
    meanObservedWallMakespanSeconds: round(mean(observed), 6),
    observedWallDeadlineComplianceRate: rows.filter(row => row.observedWallDeadlineMet).length / rows.length,
    dependencyNormalizedDeadlineComplianceRate: rows.filter(row => row.dependencyNormalizedDeadlineMet).length / rows.length,
  };
}).sort((a, b) => a.method.localeCompare(b.method));

const matchedAblations = [1, 2].map(repetition => {
  const restricted = workflowRows.find(row => row.method === 'archflow-fixed-arm' && row.repetition === repetition);
  const full = workflowRows.find(row => row.method === 'archflow-full' && row.repetition === repetition);
  if (!restricted || !full) return null;
  return {
    repetition,
    restrictedRunId: restricted.runId,
    fullRunId: full.runId,
    assignmentsIdentical: restricted.architectures === full.architectures && restricted.distinctConfigurations === full.distinctConfigurations,
    restrictedCostUsd: restricted.estimatedProviderCostUsd,
    fullCostUsd: full.estimatedProviderCostUsd,
    observedCostSavingPercent: round(100 * (restricted.estimatedProviderCostUsd - full.estimatedProviderCostUsd) / restricted.estimatedProviderCostUsd, 6),
    restrictedNormalizedMakespanSeconds: restricted.dependencyNormalizedMakespanSeconds,
    fullNormalizedMakespanSeconds: full.dependencyNormalizedMakespanSeconds,
    bothObservedWallDeadlineFeasible: restricted.observedWallDeadlineMet && full.observedWallDeadlineMet,
    bothDependencyNormalizedDeadlineFeasible: restricted.dependencyNormalizedDeadlineMet && full.dependencyNormalizedDeadlineMet,
    causalInterpretation: 'No architecture-selection benefit: both plans assign the same ARM64 0.25-vCPU/0.5-GB mode to every task; observed differences are execution variability.',
  };
}).filter(Boolean);

const failureCostRows = failures.map(task => ({
  taskId: task.taskId,
  runId: task.runId,
  method: task.method,
  taskClass: task.taskClass,
  stopCode: task.stopCode,
  stoppedReason: task.stoppedReason,
  conservativeEstimatedCostUsd: round(task.costUsd, 12),
}));

const errorSummary = {
  taskApplicationMaeSeconds: round(mean(predictionRows.map(row => row.applicationAbsoluteErrorSeconds)), 6),
  taskApplicationMapePercent: round(mean(predictionRows.map(row => row.applicationAbsolutePercentageError)), 6),
  taskLifecycleMaeSeconds: round(mean(predictionRows.map(row => row.lifecycleAbsoluteErrorSeconds)), 6),
  taskLifecycleMapePercent: round(mean(predictionRows.map(row => row.lifecycleAbsolutePercentageError)), 6),
  workflowNormalizedMaeSeconds: round(mean(workflowRows.map(row => Math.abs(row.dependencyNormalizedMakespanSeconds - row.predictedMakespanSeconds))), 6),
  workflowNormalizedMapePercent: round(mean(workflowRows.map(row => Math.abs(row.dependencyNormalizedMakespanSeconds - row.predictedMakespanSeconds) / row.dependencyNormalizedMakespanSeconds * 100)), 6),
};

const profileCells = profile.cells ?? [];
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidence: {
    rawPath: path.relative(root, rawPath),
    capturedAt: raw.capturedAt,
    ecsTaskRecords: allTasks.length,
    successfulTaskExecutions: successfulTasks.length,
    failedToStartAttempts: failures.length,
    completedWorkflowExecutions: workflowRows.length,
    uniqueMethods: [...new Set(workflowRows.map(row => row.method))].length,
    outputObjects: raw.objects.length,
  },
  experiment: {
    region: raw.region,
    deadlineSeconds: 420,
    maxConcurrentTasks: 2,
    resourceMode: '0.25 vCPU / 0.5 GB',
    pricingBasis: pricing.basis,
    primaryObservedMetric: 'observedWallMakespanSeconds includes actual control-plane/orchestration gaps',
    diagnosticMetric: 'dependencyNormalizedMakespanSeconds uses measured task lifecycle durations with immediate dependency release',
  },
  workflowRows,
  methodSummaries,
  matchedAblations,
  predictionError: errorSummary,
  failures: failureCostRows,
  totalSuccessfulWorkflowCostUsd: round(workflowRows.reduce((sum, row) => sum + row.estimatedProviderCostUsd, 0), 12),
  conservativeFailedAttemptCostUsd: round(failureCostRows.reduce((sum, row) => sum + (row.conservativeEstimatedCostUsd ?? 0), 0), 12),
};

writeCsv('task-observations.csv', successfulTasks.map(task => ({ ...task, successful: String(task.successful) })), [
  'taskArn','runId','method','repetition','nodeId','taskClass','branch','architecture','actualArchitecture','mode','vCpu','memoryGb','createdAt','pullStartedAt','pullStoppedAt','startedAt','stoppedAt','applicationSeconds','imagePullSeconds','fullLifecycleSeconds','providerMeteredSeconds','billableSeconds','computeMemoryUsd','publicIpv4Usd','costUsd','outputBytes','outputSha256','outputObjectKey','successful'
]);
writeCsv('workflow-results.csv', workflowRows, Object.keys(workflowRows[0]));
writeCsv('prediction-errors.csv', predictionRows, Object.keys(predictionRows[0]));
writeCsv('architecture-ablation.csv', matchedAblations, Object.keys(matchedAblations[0]));
writeCsv('failed-attempts.csv', failureCostRows, Object.keys(failureCostRows[0]));
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const svgBars = ({ title, subtitle, rows, valueKey, labelKey, unit, deadline = null, colors = {} }) => {
  const width = 1000, left = 250, right = 55, top = 95, rowHeight = 48;
  const height = top + rows.length * rowHeight + 70;
  const maxValue = Math.max(...rows.map(row => row[valueKey]), deadline ?? 0) * 1.12 || 1;
  const scale = (width - left - right) / maxValue;
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight;
    const value = row[valueKey];
    const color = colors[row[labelKey]] ?? (index % 2 ? '#0f766e' : '#2563eb');
    return `<text x="${left - 12}" y="${y + 21}" text-anchor="end" font-size="14">${esc(row[labelKey])}</text><rect x="${left}" y="${y}" width="${Math.max(1, value * scale)}" height="28" rx="4" fill="${color}"/><text x="${left + value * scale + 8}" y="${y + 20}" font-size="13">${value.toFixed(unit === 'USD' ? 6 : 2)} ${unit}</text>`;
  }).join('');
  const line = deadline == null ? '' : `<line x1="${left + deadline * scale}" x2="${left + deadline * scale}" y1="${top - 12}" y2="${top + rows.length * rowHeight}" stroke="#dc2626" stroke-width="3" stroke-dasharray="7 5"/><text x="${left + deadline * scale + 6}" y="${top - 18}" fill="#dc2626" font-size="13">deadline ${deadline}s</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="30" y="38" font-size="24" font-weight="700">${esc(title)}</text><text x="30" y="64" font-size="14" fill="#475569">${esc(subtitle)}</text>${bars}${line}<text x="${left}" y="${height - 22}" font-size="12" fill="#64748b">Generated from preserved AWS ECS telemetry; costs are public-rate estimates, not invoice-confirmed.</text></svg>`;
};

const taskClassRows = [];
for (const [key, rows] of Map.groupBy(successfulTasks, task => `${task.taskClass}|${task.architecture}`)) {
  const [taskClass, architecture] = key.split('|');
  taskClassRows.push({ label: `${taskClass} ${architecture}`, value: mean(rows.map(row => row.applicationSeconds)) });
}
taskClassRows.sort((a, b) => a.label.localeCompare(b.label));
fs.writeFileSync(path.join(figDir, '01-task-class-execution-time.svg'), svgBars({ title:'ARM64 vs x86 application time by task class', subtitle:'Holdout tasks; mean application-marker duration', rows:taskClassRows, valueKey:'value', labelKey:'label', unit:'seconds' }));

const profileCostRows = profileCells.map(cell => ({ label:`${cell.taskClass} ${cell.resourceModeId}`, value:cell.estimatedProviderCostUsd.mean })).sort((a,b)=>a.label.localeCompare(b.label));
fs.writeFileSync(path.join(figDir, '02-profile-task-cost.svg'), svgBars({ title:'Profiled task cost by resource configuration', subtitle:'Training observations, including 60-second billing minimum and public IPv4 estimate', rows:profileCostRows, valueKey:'value', labelKey:'label', unit:'USD' }));

const r1 = workflowRows.filter(row => row.repetition === 1).sort((a,b)=>a.method.localeCompare(b.method));
fs.writeFileSync(path.join(figDir, '03-workflow-cost-five-methods.svg'), svgBars({ title:'Real AWS workflow cost: five-method comparison', subtitle:'Repetition 1; successful tasks only', rows:r1, valueKey:'estimatedProviderCostUsd', labelKey:'method', unit:'USD' }));
fs.writeFileSync(path.join(figDir, '04-workflow-makespan-deadline.svg'), svgBars({ title:'Observed end-to-end workflow makespan', subtitle:'Includes actual remote orchestration/control-plane release gaps', rows:r1, valueKey:'observedWallMakespanSeconds', labelKey:'method', unit:'seconds', deadline:420 }));

const ablationRows = workflowRows.filter(row => ['archflow-fixed-arm','archflow-full'].includes(row.method)).map(row => ({ label:`${row.method} r${row.repetition}`, value:row.estimatedProviderCostUsd }));
fs.writeFileSync(path.join(figDir, '05-architecture-ablation.svg'), svgBars({ title:'Architecture-selection ablation', subtitle:'Full and fixed-ARM plans used identical all-ARM assignments; differences are run variability', rows:ablationRows, valueKey:'value', labelKey:'label', unit:'USD' }));

const predRows = workflowRows.map(row => ({ label:`${row.method} r${row.repetition} predicted`, value:row.predictedMakespanSeconds })).concat(workflowRows.map(row => ({ label:`${row.method} r${row.repetition} measured-normalized`, value:row.dependencyNormalizedMakespanSeconds })));
fs.writeFileSync(path.join(figDir, '06-predicted-vs-measured.svg'), svgBars({ title:'Predicted vs measured workflow runtime', subtitle:'Measured value is dependency-normalized task lifecycle, not wall-clock orchestration', rows:predRows, valueKey:'value', labelKey:'label', unit:'seconds', deadline:420 }));

const markdown = `# Real AWS final experiment summary\n\n`+
  `Generated from \`${path.relative(root, rawPath)}\`. The five-method matrix has one complete execution per method; full ArchFlow-H and fixed-ARM have a second matched execution.\n\n`+
  `| Method | n | Architecture policy | Mean cost (USD) | Mean dependency-normalized makespan (s) | Mean observed wall makespan (s) | Wall deadline compliance |\n|---|---:|---|---:|---:|---:|---:|\n`+
  methodSummaries.map(row => `| ${row.method} | ${row.repetitions} | ${row.architecturePolicy} | ${row.meanCostUsd.toFixed(9)} | ${row.meanDependencyNormalizedMakespanSeconds.toFixed(3)} | ${row.meanObservedWallMakespanSeconds.toFixed(3)} | ${(row.observedWallDeadlineComplianceRate*100).toFixed(0)}% |`).join('\n')+
  `\n\nThe primary observed wall-clock result includes real task startup, pulls, data transfer, and the remote control-plane release delays. All executions exceeded the predeclared 420-second deadline under that metric. The dependency-normalized diagnostic immediately releases successors and therefore isolates measured Fargate task lifecycles from human/tool-call gaps; it must not be presented as the observed end-to-end result.\n\n`+
  `Full ArchFlow-H selected ARM64 0.25 vCPU / 0.5 GB for every task, exactly matching fixed-ARM ArchFlow. Therefore architecture selection produced **no demonstrated incremental assignment or cost benefit**. Any measured cost difference between the identical plans is run-to-run variation, and no valid deadline-constrained saving is claimed because the observed wall executions were infeasible.\n\n`+
  `Prediction error (35 successful holdout tasks): lifecycle MAE ${errorSummary.taskLifecycleMaeSeconds.toFixed(3)} s, lifecycle MAPE ${errorSummary.taskLifecycleMapePercent.toFixed(2)}%; workflow dependency-normalized MAE ${errorSummary.workflowNormalizedMaeSeconds.toFixed(3)} s.\n\n`+
  `Three ECS attempts failed before application startup because of public-registry image-pull failures. Their records are preserved in \`failed-attempts.csv\`; successful retries used the unchanged plan.\n`;
fs.writeFileSync(path.join(outDir, 'README.md'), markdown);

console.log(JSON.stringify({ evidence: summary.evidence, methodSummaries, matchedAblations, predictionError: errorSummary, totals: { successfulWorkflowCostUsd: summary.totalSuccessfulWorkflowCostUsd, conservativeFailedAttemptCostUsd: summary.conservativeFailedAttemptCostUsd } }, null, 2));
