#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const rawPath = path.join(root, 'artifacts/archflow/aws/final/raw/final-evaluation-all.json');
const resultsDir = path.join(root, 'artifacts/archflow/aws/final/results');
const plansDir = path.join(root, 'artifacts/archflow/aws/final/plans');
const rawBytes = fs.readFileSync(rawPath);
const raw = JSON.parse(rawBytes);
const summary = JSON.parse(fs.readFileSync(path.join(resultsDir, 'summary.json'), 'utf8'));
const expectedSha256 = 'f36637c628fbcc47f3ddcac6f9da8fdc2aa41008e068b84c2a06452de9777142';

assert.equal(crypto.createHash('sha256').update(rawBytes).digest('hex'), expectedSha256, 'raw evidence checksum');
assert.equal(raw.tasks.length, 38, 'ECS task-record count');
assert.equal(raw.objects.length, 28, 'S3 output-object count');

const tags = task => Object.fromEntries(task.tags.map(tag => [tag.key, tag.value]));
const successful = raw.tasks.filter(record => record.task.stopCode === 'EssentialContainerExited'
  && record.task.containers.length === 3
  && record.task.containers.every(container => container.exitCode === 0));
const failed = raw.tasks.filter(record => record.task.stopCode === 'TaskFailedToStart');
assert.equal(successful.length, 35, 'successful task count');
assert.equal(failed.length, 3, 'pre-start failure count');
assert.ok(successful.every(record => record.workerLogEvents.length === 4), 'successful tasks must have four worker markers');
assert.ok(failed.every(record => record.workerLogEvents.length === 0), 'pre-start tasks must have no application markers');

const byRun = Map.groupBy(successful, record => tags(record.task).RunId);
assert.equal(byRun.size, 7, 'complete workflow count');
const expectedRuns = new Set([
  'final-chunkfunc-x86-r1', 'final-chunkfunc-arm-r1',
  'final-archflow-fixed-x86-r1', 'final-archflow-fixed-arm-r1', 'final-archflow-full-r1',
  'final-archflow-fixed-arm-r2', 'final-archflow-full-r2',
]);
assert.deepEqual(new Set(byRun.keys()), expectedRuns, 'workflow run IDs');

for (const [runId, records] of byRun) {
  assert.equal(records.length, 5, `${runId}: task count`);
  const node = Object.fromEntries(records.map(record => {
    const tag = tags(record.task);
    const id = tag.TaskClass === 'cut' ? `cut-${tag.Branch}` : tag.TaskClass;
    return [id, record.task];
  }));
  assert.deepEqual(new Set(Object.keys(node)), new Set(['generate-source','cut-a','cut-b','merge','validate']), `${runId}: DAG nodes`);
  assert.ok(Date.parse(node['cut-a'].createdAt) >= Date.parse(node['generate-source'].stoppedAt), `${runId}: cut-a dependency`);
  assert.ok(Date.parse(node['cut-b'].createdAt) >= Date.parse(node['generate-source'].stoppedAt), `${runId}: cut-b dependency`);
  assert.ok(Date.parse(node.merge.createdAt) >= Math.max(Date.parse(node['cut-a'].stoppedAt), Date.parse(node['cut-b'].stoppedAt)), `${runId}: merge dependency`);
  assert.ok(Date.parse(node.validate.createdAt) >= Date.parse(node.merge.stoppedAt), `${runId}: validate dependency`);
  const runObjects = raw.objects.filter(object => object.Key.startsWith(`dag/final/${runId}/`));
  assert.equal(runObjects.length, 4, `${runId}: persisted data objects`);
}

const planFiles = fs.readdirSync(plansDir).filter(file => file.endsWith('.json'));
assert.equal(planFiles.length, 5, 'frozen plan count');
const plans = planFiles.map(file => JSON.parse(fs.readFileSync(path.join(plansDir, file), 'utf8')));
const earliestTask = Math.min(...successful.map(record => Date.parse(record.task.createdAt)));
for (const plan of plans) {
  assert.equal(plan.deadlineSeconds, 420, `${plan.methodId}: deadline`);
  assert.equal(plan.maxConcurrentTasks, 2, `${plan.methodId}: concurrency`);
  assert.ok(Date.parse(plan.generatedAt) < earliestTask, `${plan.methodId}: generated before holdout`);
  assert.equal(plan.schedule.taskAssignments.length, 5, `${plan.methodId}: assignments`);
  assert.ok(plan.schedule.taskAssignments.every(assignment => assignment.profileProvenance.kind === 'measured-aws-fargate'), `${plan.methodId}: measured provenance`);
  assert.ok(plan.schedule.taskAssignments.every(assignment => assignment.resourceMode.vCpu === 0.25 && assignment.resourceMode.memoryGb === 0.5), `${plan.methodId}: selected low mode`);
  const architectures = new Set(plan.schedule.taskAssignments.map(assignment => assignment.resourceMode.architecture));
  if (plan.methodId.includes('x86')) assert.deepEqual(architectures, new Set(['x86_64']), `${plan.methodId}: x86 isolation`);
  else assert.deepEqual(architectures, new Set(['arm64']), `${plan.methodId}: ARM selection`);
}

const fullPlan = plans.find(plan => plan.methodId === 'archflow-full');
const fixedArmPlan = plans.find(plan => plan.methodId === 'archflow-fixed-arm');
assert.deepEqual(
  fullPlan.schedule.taskAssignments.map(item => [item.taskId, item.resourceMode.id]),
  fixedArmPlan.schedule.taskAssignments.map(item => [item.taskId, item.resourceMode.id]),
  'full and fixed-ARM assignments must be identical',
);

assert.equal(summary.evidence.successfulTaskExecutions, 35, 'summary successful tasks');
assert.equal(summary.evidence.completedWorkflowExecutions, 7, 'summary workflows');
assert.equal(summary.evidence.uniqueMethods, 5, 'summary methods');
assert.equal(summary.matchedAblations.length, 2, 'matched ablation repetitions');
assert.ok(summary.matchedAblations.every(row => row.assignmentsIdentical), 'matched assignments');
assert.ok(summary.methodSummaries.every(row => row.observedWallDeadlineComplianceRate === 0), 'wall-clock deadline outcomes');

const csvRows = file => fs.readFileSync(path.join(resultsDir, file), 'utf8').trim().split('\n').length - 1;
assert.equal(csvRows('task-observations.csv'), 35, 'task CSV rows');
assert.equal(csvRows('workflow-results.csv'), 7, 'workflow CSV rows');
assert.equal(csvRows('prediction-errors.csv'), 35, 'prediction CSV rows');
assert.equal(csvRows('architecture-ablation.csv'), 2, 'ablation CSV rows');
assert.equal(csvRows('failed-attempts.csv'), 3, 'failure CSV rows');

const figures = fs.readdirSync(path.join(resultsDir, 'figures')).filter(file => file.endsWith('.svg'));
assert.equal(figures.length, 6, 'figure count');
for (const figure of figures) assert.match(fs.readFileSync(path.join(resultsDir, 'figures', figure), 'utf8'), /^<svg[\s\S]*<\/svg>$/, `${figure}: SVG structure`);

console.log(JSON.stringify({
  verified: true,
  rawSha256: expectedSha256,
  ecsTaskRecords: raw.tasks.length,
  successfulTasks: successful.length,
  failedToStartAttempts: failed.length,
  workflows: byRun.size,
  methods: summary.evidence.uniqueMethods,
  figures: figures.length,
}, null, 2));
