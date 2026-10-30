#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [planInput, outputInput] = process.argv.slice(2);
if (!planInput || !outputInput) {
  throw new Error('Usage: node scripts/generate_phase6_manifest.mjs <plan.json> <output.json>');
}

const planPath = path.resolve(planInput);
const outputPath = path.resolve(outputInput);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const experiments = [];
const ids = new Set();

for (const workload of plan.workloads) {
  for (const deadline of workload.deadlines) {
    for (const method of plan.methods) {
      const id = `${workload.id}-${deadline.id}-${method.id}`;
      if (ids.has(id)) throw new Error(`Duplicate generated experiment ID: ${id}`);
      ids.add(id);
      experiments.push({
        id,
        methodId: method.id,
        methodLabel: method.label,
        workloadId: workload.id,
        workloadCharacteristic: workload.characteristic,
        deadlineCondition: deadline.id,
        deadlineSeconds: deadline.seconds,
        kind: workload.kind,
        workflow: workload.workflow,
        ...(workload.scenario ? { scenario: workload.scenario } : {}),
        ...(workload.proxyMapping ? { proxyMapping: workload.proxyMapping } : {}),
        architecturePerformanceProfileSet: workload.architecturePerformanceProfileSet,
        scheduler: method.scheduler,
        architecture: method.architecture,
        ...(method.scheduler === 'archflow-h' ? {
          allowArchitectureSelection: method.allowArchitectureSelection,
          fixedArchitecture: method.fixedArchitecture,
        } : {}),
        ...(plan.concurrencyLimit === null ? {} : { maxConcurrentTasks: plan.concurrencyLimit }),
      });
    }
  }
}

if (experiments.length !== plan.workloads.length * plan.methods.length * 3) {
  throw new Error('Every workload must define exactly three deadline conditions.');
}

const manifest = {
  schemaVersion: 1,
  pricing: plan.pricing,
  resourceModes: plan.resourceModes,
  architecturePerformanceProfiles: plan.architecturePerformanceProfiles,
  phase6Plan: path.relative(path.dirname(outputPath), planPath),
  experiments,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${experiments.length} Phase 6 experiments at ${outputPath}`);
