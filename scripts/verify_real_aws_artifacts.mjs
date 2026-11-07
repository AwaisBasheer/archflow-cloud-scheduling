#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../artifacts/archflow/aws/', import.meta.url);
const readJson = relative => JSON.parse(readFileSync(new URL(relative, root), 'utf8'));
const close = (a, b, tolerance = 1e-15) => Math.abs(a - b) <= tolerance;
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const csv = readFileSync(new URL('profiles/ffmpeg-smoke-telemetry.csv', root), 'utf8').trim().split('\n');
const headers = csv[0].split(',');
const samples = csv.slice(1).map(line => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
assert(samples.length === 8, `expected 8 smoke samples, found ${samples.length}`);
assert(samples.every(sample => sample.successful === 'true'), 'a smoke sample was unsuccessful');
assert(samples.filter(sample => sample.architecture === 'ARM64').length === 4, 'expected 4 ARM64 smoke samples');
assert(samples.filter(sample => sample.architecture === 'X86_64').length === 4, 'expected 4 X86_64 smoke samples');

const arm = readJson('workflows/ffmpeg-arm-only-r1.json');
const x86 = readJson('workflows/ffmpeg-x86-only-r1.json');
for (const [workflow, architecture] of [[arm, 'ARM64'], [x86, 'X86_64']]) {
    assert(workflow.nodes.length === 5, `${workflow.workflowId} does not contain five nodes`);
    assert(workflow.nodes.every(node => node.architecture === architecture), `${workflow.workflowId} violates its architecture restriction`);
    assert(workflow.deadlineMet === (workflow.makespanSeconds <= workflow.deadlineSeconds), `${workflow.workflowId} has an inconsistent deadline flag`);
    const taskCost = workflow.nodes.reduce((sum, node) => sum + node.estimatedCostUsd, 0);
    assert(close(taskCost, workflow.estimatedProviderCostUsd), `${workflow.workflowId} task costs do not sum to workflow cost`);
}

const snapshotPath = new URL('task-telemetry/aws-control-plane-export.json', root);
const snapshotBytes = readFileSync(snapshotPath);
const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
assert(snapshot.tasks.length === 18, `expected 18 ECS tasks, found ${snapshot.tasks.length}`);
const containers = snapshot.tasks.flatMap(task => task.containers ?? []);
assert(containers.length === 38, `expected 38 container records, found ${containers.length}`);
assert(containers.every(container => container.exitCode === 0), 'a recorded container exit code was nonzero');

const result = {
    smokeTasks: samples.length,
    ecsTasks: snapshot.tasks.length,
    containerRecords: containers.length,
    arm: { makespanSeconds: arm.makespanSeconds, costUsd: arm.estimatedProviderCostUsd, deadlineMet: arm.deadlineMet },
    x86: { makespanSeconds: x86.makespanSeconds, costUsd: x86.estimatedProviderCostUsd, deadlineMet: x86.deadlineMet },
    armMakespanReductionPercent: (1 - arm.makespanSeconds / x86.makespanSeconds) * 100,
    armCostReductionPercent: (1 - arm.estimatedProviderCostUsd / x86.estimatedProviderCostUsd) * 100,
    controlPlaneSnapshotSha256: createHash('sha256').update(snapshotBytes).digest('hex'),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
