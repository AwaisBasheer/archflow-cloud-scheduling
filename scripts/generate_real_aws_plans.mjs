#!/usr/bin/env node

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const core = require(resolve(repositoryRoot, 'ts/dist/packages/archflow-core'));
const readJson = path => JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));
const outputRoot = resolve(repositoryRoot, 'artifacts/archflow/aws/final');
mkdirSync(resolve(outputRoot, 'plans'), { recursive: true });

const rates = readJson('artifacts/archflow/aws/configurations/pricing-snapshot.json').rates;
const pricing = readJson('ts/scenarios/archflow/config/fargate-pricing-us-east-1-2026-10-10.json');
const lowSnapshot = readJson('artifacts/archflow/aws/task-telemetry/profile-low-r1.json');
const historical = [
    readJson('artifacts/archflow/aws/workflows/ffmpeg-arm-only-r1.json'),
    readJson('artifacts/archflow/aws/workflows/ffmpeg-x86-only-r1.json'),
];
const modeCatalog = readJson('ts/scenarios/archflow/config/fargate-resource-modes.json');
const selectedModeIds = new Set([
    'x86-0.25vcpu-0.5gb', 'x86-1vcpu-2gb',
    'arm64-0.25vcpu-0.5gb', 'arm64-1vcpu-2gb',
]);
const modes = Object.fromEntries(modeCatalog.modes.filter(mode => selectedModeIds.has(mode.id)).map(mode => [mode.id, mode]));

const seconds = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;
const tagsFor = task => Object.fromEntries((task.tags ?? []).map(tag => [tag.key, tag.value]));
const parseMessages = events => events.map(event => JSON.parse(event.message));
const classForNode = id => id.startsWith('cut-') ? 'cut' : id;
const architectureFor = value => value === 'ARM64' ? 'arm64' : value === 'X86_64' ? 'x86_64' : value;
const modeIdFor = (architecture, cpuUnits) => `${architecture === 'arm64' ? 'arm64' : 'x86'}-${cpuUnits === 256 ? '0.25vcpu-0.5gb' : '1vcpu-2gb'}`;
const costFor = (architecture, cpuUnits, memoryMiB, billableSeconds, lifecycleSeconds) => {
    const cpu = architecture === 'arm64' ? rates.armVCpuHour : rates.x86VCpuHour;
    const memory = architecture === 'arm64' ? rates.armMemoryGbHour : rates.x86MemoryGbHour;
    return billableSeconds * ((cpuUnits / 1024) * cpu + (memoryMiB / 1024) * memory) / 3600
        + lifecycleSeconds * rates.publicIpv4Hour / 3600;
};

const observations = [];
for (const entry of lowSnapshot.tasks) {
    const task = entry.task;
    const tags = tagsFor(task);
    const messages = parseMessages(entry.workerLogEvents);
    const start = messages.find(message => message.event === 'archflow_application_start');
    const end = messages.find(message => message.event === 'archflow_application_end');
    const runtime = messages.find(message => message.event === 'archflow_runtime');
    const output = messages.find(message => message.event === 'archflow_output_validated');
    const architecture = architectureFor(tags.Architecture);
    const cpuUnits = Number(task.cpu);
    const memoryMiB = Number(task.memory);
    const applicationSeconds = seconds(start.timestamp, end.timestamp);
    const fullLifecycleSeconds = seconds(task.createdAt, task.stoppedAt);
    const providerMeteredSeconds = seconds(task.pullStartedAt, task.stoppedAt);
    const billableSeconds = Math.ceil(Math.max(60, providerMeteredSeconds));
    observations.push({
        observationId: task.taskArn.split('/').at(-1),
        datasetRole: 'training',
        source: 'real-aws-20261010-final-low-mode',
        taskArn: task.taskArn,
        taskClass: tags.TaskClass,
        branch: tags.Branch ?? null,
        architecture,
        actualArchitecture: runtime.architecture,
        resourceModeId: modeIdFor(architecture, cpuUnits),
        cpuUnits,
        memoryMiB,
        applicationSeconds,
        imagePullSeconds: seconds(task.pullStartedAt, task.pullStoppedAt),
        fullLifecycleSeconds,
        startupAndTransferSeconds: fullLifecycleSeconds - applicationSeconds,
        providerMeteredSeconds,
        billableSeconds,
        estimatedProviderCostUsd: costFor(architecture, cpuUnits, memoryMiB, billableSeconds, fullLifecycleSeconds),
        outputBytes: output.sizeBytes,
        outputSha256: output.sha256,
        successful: task.containers.every(container => container.exitCode === 0),
    });
}

for (const workflow of historical) {
    for (const node of workflow.nodes) {
        const architecture = architectureFor(node.architecture);
        observations.push({
            observationId: node.taskArn.split('/').at(-1),
            datasetRole: 'training',
            source: workflow.workflowId,
            taskArn: node.taskArn,
            taskClass: classForNode(node.nodeId),
            branch: node.nodeId.startsWith('cut-') ? node.nodeId.at(-1) : null,
            architecture,
            actualArchitecture: architecture === 'arm64' ? 'aarch64' : 'x86_64',
            resourceModeId: modeIdFor(architecture, node.cpuUnits),
            cpuUnits: node.cpuUnits,
            memoryMiB: node.memoryMiB,
            applicationSeconds: node.applicationSeconds,
            imagePullSeconds: node.imagePullSeconds,
            fullLifecycleSeconds: node.fullLifecycleSeconds,
            startupAndTransferSeconds: node.fullLifecycleSeconds - node.applicationSeconds,
            providerMeteredSeconds: node.billableSeconds,
            billableSeconds: node.billableSeconds,
            estimatedProviderCostUsd: node.estimatedCostUsd,
            outputBytes: node.outputBytes ?? node.validatedBytes,
            outputSha256: node.outputSha256 ?? node.validatedSha256,
            successful: true,
        });
    }
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sampleStdDev = values => values.length < 2 ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1));
const stats = values => ({ count: values.length, mean: mean(values), median: median(values), sampleStdDev: sampleStdDev(values), min: Math.min(...values), max: Math.max(...values) });

const cells = [];
for (const taskClass of ['generate-source', 'cut', 'merge', 'validate']) {
    for (const resourceModeId of selectedModeIds) {
        const items = observations.filter(item => item.taskClass === taskClass && item.resourceModeId === resourceModeId);
        if (!items.length) continue;
        cells.push({
            taskClass,
            resourceModeId,
            architecture: modes[resourceModeId].architecture,
            observationIds: items.map(item => item.observationId),
            applicationSeconds: stats(items.map(item => item.applicationSeconds)),
            startupAndTransferSeconds: stats(items.map(item => item.startupAndTransferSeconds)),
            fullLifecycleSeconds: stats(items.map(item => item.fullLifecycleSeconds)),
            estimatedProviderCostUsd: stats(items.map(item => item.estimatedProviderCostUsd)),
        });
    }
}

const profilesFor = taskClass => cells.filter(cell => cell.taskClass === taskClass).map(cell => ({
    resourceModeId: cell.resourceModeId,
    executionSeconds: cell.applicationSeconds.mean,
    startupOverheadSeconds: cell.startupAndTransferSeconds.mean,
    provenance: {
        kind: 'measured-aws-fargate',
        source: 'artifacts/archflow/aws/profiles/measured-ffmpeg-task-matrix.json',
        notes: `Arithmetic mean of independent training observations: ${cell.observationIds.join(', ')}.`,
    },
}));

const tasks = [
    { id: 'generate-source', taskClass: 'generate-source', predecessorIds: [], successorIds: ['cut-a', 'cut-b'] },
    { id: 'cut-a', taskClass: 'cut', predecessorIds: ['generate-source'], successorIds: ['merge'] },
    { id: 'cut-b', taskClass: 'cut', predecessorIds: ['generate-source'], successorIds: ['merge'] },
    { id: 'merge', taskClass: 'merge', predecessorIds: ['cut-a', 'cut-b'], successorIds: ['validate'] },
    { id: 'validate', taskClass: 'validate', predecessorIds: ['merge'], successorIds: [] },
].map(task => ({ ...task, workloadSize: 1, profiles: profilesFor(task.taskClass) }));
const workflow = { schemaVersion: 1, id: 'real-ffmpeg-five-node', deadlineSeconds: 420, tasks, provenance: 'Measured AWS Fargate training observations; no synthetic factors.' };

const methods = [
    ['chunkfunc-x86', () => new core.FixedArchitectureProportionalDeadlineScheduler('X86_64').schedule(workflow, modes, pricing, { maxConcurrentTasks: 2 })],
    ['chunkfunc-arm', () => new core.FixedArchitectureProportionalDeadlineScheduler('ARM64').schedule(workflow, modes, pricing, { maxConcurrentTasks: 2 })],
    ['archflow-fixed-x86', () => new core.ArchFlowHScheduler().schedule(workflow, modes, pricing, { maxConcurrentTasks: 2 }, { allowArchitectureSelection: false, fixedArchitecture: 'X86_64' })],
    ['archflow-fixed-arm', () => new core.ArchFlowHScheduler().schedule(workflow, modes, pricing, { maxConcurrentTasks: 2 }, { allowArchitectureSelection: false, fixedArchitecture: 'ARM64' })],
    ['archflow-full', () => new core.ArchFlowHScheduler().schedule(workflow, modes, pricing, { maxConcurrentTasks: 2 }, { allowArchitectureSelection: true, fixedArchitecture: null })],
];

const planGeneratedAt = new Date().toISOString();
const plans = methods.map(([methodId, schedule]) => ({
    schemaVersion: 1,
    methodId,
    generatedAt: planGeneratedAt,
    generatedBeforeFinalExecution: true,
    deadlineSeconds: 420,
    maxConcurrentTasks: 2,
    workflow,
    schedule: schedule(),
}));

const csvHeaders = ['observationId','datasetRole','source','taskArn','taskClass','branch','architecture','actualArchitecture','resourceModeId','cpuUnits','memoryMiB','applicationSeconds','imagePullSeconds','fullLifecycleSeconds','startupAndTransferSeconds','providerMeteredSeconds','billableSeconds','estimatedProviderCostUsd','outputBytes','outputSha256','successful'];
const csvCell = value => value === null || value === undefined ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
writeFileSync(resolve(repositoryRoot, 'artifacts/archflow/aws/profiles/ffmpeg-task-profile-observations.csv'), `${csvHeaders.join(',')}\n${observations.map(row => csvHeaders.map(header => csvCell(row[header])).join(',')).join('\n')}\n`);
writeFileSync(resolve(repositoryRoot, 'artifacts/archflow/aws/profiles/measured-ffmpeg-task-matrix.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), datasetRole: 'training', observations, cells }, null, 2)}\n`);
writeFileSync(resolve(outputRoot, 'measured-workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
writeFileSync(resolve(outputRoot, 'resource-modes.json'), `${JSON.stringify({ schemaVersion: 1, modes: Object.values(modes) }, null, 2)}\n`);
writeFileSync(resolve(outputRoot, 'pricing.json'), `${JSON.stringify(pricing, null, 2)}\n`);
for (const plan of plans) writeFileSync(resolve(outputRoot, 'plans', `${plan.methodId}.json`), `${JSON.stringify(plan, null, 2)}\n`);

process.stdout.write(`${JSON.stringify(plans.map(plan => ({ methodId: plan.methodId, feasible: plan.schedule.feasible, predictedMakespanSeconds: plan.schedule.simulatedMakespanSeconds, predictedCostUsd: plan.schedule.estimatedExecutionCostUsd, assignments: plan.schedule.taskAssignments.map(item => ({ taskId: item.taskId, resourceModeId: item.resourceMode.id })) })), null, 2)}\n`);
