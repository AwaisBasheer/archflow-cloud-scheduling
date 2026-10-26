import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Yaml from 'js-yaml';
import {
    ArchitecturePerformanceConfig,
    ArchitectureRestriction,
    ArchFlowSchedulerOptions,
    ArchFlowHScheduler,
    ChunkFuncExecutionDescription,
    ChunkFuncProxyMapping,
    ChunkFuncWorkflowDescription,
    DagWorkflow,
    FargatePricingConfig,
    FixedArchitectureProportionalDeadlineScheduler,
    ResourceModeCatalog,
    ScheduleResult,
    adaptChunkFuncWorkflow,
    assertComparableWorkflowInputs,
    buildResourceModeMap,
    buildJointArchitectureWorkflow,
    cpuArchitectureFor,
    deriveArm64Workflow,
    validatePricingConfig,
} from '@archflow/core';

interface ExperimentDefinition {
    id: string;
    kind: 'chunkfunc-proxy' | 'shared-workflow';
    workflow: string;
    scenario?: string;
    proxyMapping?: string;
    architecture?: ExperimentArchitecture;
    architecturePerformanceProfileSet?: string;
    comparisonGroup?: string;
    maxConcurrentTasks?: number;
    scheduler?: 'fixed-architecture' | 'archflow-h';
    allowArchitectureSelection?: boolean;
    fixedArchitecture?: ArchitectureRestriction | null;
    deadlineSeconds?: number;
    methodId?: string;
    workloadId?: string;
    deadlineCondition?: string;
}

type ExperimentArchitecture = ArchitectureRestriction | 'JOINT';

interface ExperimentManifest {
    schemaVersion: number;
    pricing: string;
    resourceModes: string;
    architecturePerformanceProfiles?: string;
    experiments: ExperimentDefinition[];
}

interface ExperimentOutput extends ScheduleResult {
    experimentId: string;
    performanceDataKind: ExperimentDefinition['kind'];
    architectureRestriction: ExperimentArchitecture;
    architecturePerformanceProfileSet?: string;
    architecturePerformanceRandomSeed?: number;
    comparisonGroup?: string;
    pricingRegion: string;
    pricingRetrievedAt: string;
    pricingSource: string;
    architectureDistribution: Record<string, number>;
    methodId?: string;
    workloadId?: string;
    deadlineCondition?: string;
}

function parseArgs(args: string[]): { manifestPath?: string; outputDir?: string } {
    const parsed: { manifestPath?: string; outputDir?: string } = {};
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--manifest') {
            parsed.manifestPath = args[++i];
        } else if (args[i] === '--output-dir') {
            parsed.outputDir = args[++i];
        } else {
            throw new Error(`Unknown argument: ${args[i]}`);
        }
    }
    return parsed;
}

function loadJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function loadYaml<T>(filePath: string): T {
    return Yaml.load(fs.readFileSync(filePath, 'utf8')) as T;
}

function csvCell(value: unknown): string {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function findNxWorkspaceRoot(startPath: string): string {
    let candidate = path.resolve(startPath);
    let parent = path.dirname(candidate);
    while (parent !== candidate) {
        if (fs.existsSync(path.join(candidate, 'nx.json'))) {
            return candidate;
        }
        candidate = parent;
        parent = path.dirname(candidate);
    }
    if (fs.existsSync(path.join(candidate, 'nx.json'))) {
        return candidate;
    }
    throw new Error(`Could not find nx.json above ${startPath}.`);
}

const args = parseArgs(process.argv.slice(2));
const tsRoot = findNxWorkspaceRoot(__dirname);
const repositoryRoot = path.resolve(tsRoot, '..');
const manifestPath = path.resolve(tsRoot, args.manifestPath ?? 'scenarios/archflow/phase3-experiments.json');
const outputDir = path.resolve(repositoryRoot, args.outputDir ?? 'artifacts/archflow/phase3');
const manifest = loadJson<ExperimentManifest>(manifestPath);
const pricing = loadJson<FargatePricingConfig>(path.resolve(tsRoot, manifest.pricing));
const resourceCatalog = loadJson<ResourceModeCatalog>(path.resolve(tsRoot, manifest.resourceModes));
validatePricingConfig(pricing);
const resourceModes = buildResourceModeMap(resourceCatalog);
const architecturePerformanceConfig = manifest.architecturePerformanceProfiles
    ? loadJson<ArchitecturePerformanceConfig>(path.resolve(tsRoot, manifest.architecturePerformanceProfiles))
    : undefined;
const outputs: ExperimentOutput[] = [];
const comparisonBaselines = new Map<string, DagWorkflow>();
const armFactorRows: Array<Record<string, string | number | undefined>> = [];

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'experiment-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, 'pricing-config.json'), `${JSON.stringify(pricing, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, 'resource-mode-catalog.json'), `${JSON.stringify(resourceCatalog, null, 2)}\n`);
if (architecturePerformanceConfig) {
    fs.writeFileSync(
        path.join(outputDir, 'architecture-performance-config.json'),
        `${JSON.stringify(architecturePerformanceConfig, null, 2)}\n`,
    );
}

for (const experiment of manifest.experiments) {
    const architecture = experiment.architecture ?? 'X86_64';
    let baselineWorkflow: DagWorkflow;
    if (experiment.kind === 'chunkfunc-proxy') {
        if (!experiment.scenario || !experiment.proxyMapping) {
            throw new Error(`Experiment ${experiment.id} is missing scenario/proxyMapping.`);
        }
        baselineWorkflow = adaptChunkFuncWorkflow(
            loadYaml<ChunkFuncWorkflowDescription>(path.resolve(tsRoot, experiment.workflow)),
            loadYaml<ChunkFuncExecutionDescription>(path.resolve(tsRoot, experiment.scenario)),
            resourceModes,
            loadJson<ChunkFuncProxyMapping>(path.resolve(tsRoot, experiment.proxyMapping)),
        );
    } else {
        baselineWorkflow = loadJson<DagWorkflow>(path.resolve(tsRoot, experiment.workflow));
    }
    if (experiment.deadlineSeconds !== undefined) {
        if (!Number.isFinite(experiment.deadlineSeconds) || experiment.deadlineSeconds <= 0) {
            throw new Error(`Experiment ${experiment.id} has an invalid deadline override.`);
        }
        baselineWorkflow = { ...baselineWorkflow, deadlineSeconds: experiment.deadlineSeconds };
    }

    if (experiment.comparisonGroup) {
        const existingBaseline = comparisonBaselines.get(experiment.comparisonGroup);
        if (existingBaseline) {
            assertComparableWorkflowInputs(existingBaseline, baselineWorkflow);
        } else {
            comparisonBaselines.set(experiment.comparisonGroup, baselineWorkflow);
        }
    }

    const useArchFlow = experiment.scheduler === 'archflow-h' || architecture === 'JOINT';
    let workflow = baselineWorkflow;
    if (architecture === 'ARM64' || useArchFlow) {
        if (!architecturePerformanceConfig || !experiment.architecturePerformanceProfileSet) {
            throw new Error(`ARM64 experiment ${experiment.id} requires an architecture performance profile set.`);
        }
        workflow = architecture === 'ARM64' && !useArchFlow
            ? deriveArm64Workflow(
                baselineWorkflow,
                resourceModes,
                architecturePerformanceConfig,
                experiment.architecturePerformanceProfileSet,
            )
            : buildJointArchitectureWorkflow(
                baselineWorkflow,
                resourceModes,
                architecturePerformanceConfig,
                experiment.architecturePerformanceProfileSet,
            );
        assertComparableWorkflowInputs(baselineWorkflow, workflow);
        for (const task of workflow.tasks) {
            const baselineTask = baselineWorkflow.tasks.find(item => item.id === task.id);
            for (const profile of task.profiles.filter(item => item.provenance.kind === 'synthetic-arm64-derived')) {
                const baselineProfile = baselineTask?.profiles.find(item =>
                    item.resourceModeId === profile.provenance.sourceProfileId,
                );
                armFactorRows.push({
                    experimentId: experiment.id,
                    workflowId: workflow.id,
                    taskId: task.id,
                    taskClass: task.taskClass,
                    sourceResourceModeId: profile.provenance.sourceProfileId,
                    targetResourceModeId: profile.resourceModeId,
                    sourceExecutionSeconds: baselineProfile?.executionSeconds,
                    arm64ExecutionSeconds: profile.executionSeconds,
                    basePerformanceFactor: profile.provenance.basePerformanceFactor,
                    deterministicJitterFactor: profile.provenance.deterministicJitterFactor,
                    effectivePerformanceFactor: profile.provenance.effectivePerformanceFactor,
                    randomSeed: profile.provenance.randomSeed,
                });
            }
        }
    }

    const simulationOptions = experiment.maxConcurrentTasks !== undefined
        ? { maxConcurrentTasks: experiment.maxConcurrentTasks }
        : {};
    const schedulerOptions: ArchFlowSchedulerOptions = {
        allowArchitectureSelection: experiment.allowArchitectureSelection ?? true,
        fixedArchitecture: experiment.fixedArchitecture ?? null,
    };
    const result = useArchFlow
        ? new ArchFlowHScheduler().schedule(
            workflow,
            resourceModes,
            pricing,
            simulationOptions,
            schedulerOptions,
        )
        : new FixedArchitectureProportionalDeadlineScheduler(architecture)
            .schedule(workflow, resourceModes, pricing, simulationOptions);
    if (!useArchFlow) {
        const expectedArchitecture = cpuArchitectureFor(architecture);
        if (result.taskAssignments.some(assignment => assignment.resourceMode.architecture !== expectedArchitecture)) {
            throw new Error(`Experiment ${experiment.id} selected a mode outside its ${architecture} restriction.`);
        }
    } else if (!schedulerOptions.allowArchitectureSelection && schedulerOptions.fixedArchitecture) {
        const expectedArchitecture = cpuArchitectureFor(schedulerOptions.fixedArchitecture);
        if (result.taskAssignments.some(assignment => assignment.resourceMode.architecture !== expectedArchitecture)) {
            throw new Error(`ArchFlow ablation ${experiment.id} selected a forbidden architecture.`);
        }
    }
    const architectureDistribution = result.taskAssignments.reduce<Record<string, number>>(
        (counts, assignment) => ({
            ...counts,
            [assignment.resourceMode.architecture]: (counts[assignment.resourceMode.architecture] ?? 0) + 1,
        }),
        { x86_64: 0, arm64: 0 },
    );
    const output: ExperimentOutput = {
        experimentId: experiment.id,
        performanceDataKind: experiment.kind,
        architectureRestriction: architecture,
        ...(experiment.architecturePerformanceProfileSet
            ? { architecturePerformanceProfileSet: experiment.architecturePerformanceProfileSet }
            : {}),
        ...(architecture !== 'X86_64' && architecturePerformanceConfig
            ? { architecturePerformanceRandomSeed: architecturePerformanceConfig.randomSeed }
            : {}),
        ...(experiment.comparisonGroup ? { comparisonGroup: experiment.comparisonGroup } : {}),
        ...(experiment.methodId ? { methodId: experiment.methodId } : {}),
        ...(experiment.workloadId ? { workloadId: experiment.workloadId } : {}),
        ...(experiment.deadlineCondition ? { deadlineCondition: experiment.deadlineCondition } : {}),
        pricingRegion: pricing.region,
        pricingRetrievedAt: pricing.retrievedAt,
        pricingSource: pricing.source,
        ...result,
        architectureDistribution,
    };
    outputs.push(output);
    fs.writeFileSync(path.join(outputDir, `${experiment.id}.json`), `${JSON.stringify(output, null, 2)}\n`);
    const workflowOutputDir = path.join(outputDir, 'effective-workflows');
    fs.mkdirSync(workflowOutputDir, { recursive: true });
    fs.writeFileSync(
        path.join(workflowOutputDir, `${experiment.id}.json`),
        `${JSON.stringify(workflow, null, 2)}\n`,
    );
}

let summaryCsv = 'experimentId,workflowId,architectureRestriction,schedulerId,deadlineSeconds,simulatedMakespanSeconds,estimatedExecutionCostUsd,deadlineMet,feasible,schedulingDecisionOverheadMs,selectionIterations\n';
for (const output of outputs) {
    summaryCsv += [
        output.experimentId,
        output.workflowId,
        output.architectureRestriction,
        output.schedulerId,
        output.deadlineSeconds,
        output.simulatedMakespanSeconds,
        output.estimatedExecutionCostUsd,
        output.deadlineMet,
        output.feasible,
        output.schedulingDecisionOverheadMs,
        output.selectionIterations,
    ].map(csvCell).join(',') + '\n';
}
fs.writeFileSync(path.join(outputDir, 'summary.csv'), summaryCsv);

if (armFactorRows.length > 0) {
    const factorColumns = Object.keys(armFactorRows[0]);
    let factorCsv = `${factorColumns.join(',')}\n`;
    for (const row of armFactorRows) {
        factorCsv += factorColumns.map(column => csvCell(row[column])).join(',') + '\n';
    }
    fs.writeFileSync(path.join(outputDir, 'arm64-performance-factors.csv'), factorCsv);
}

interface ArchitectureComparison {
    comparisonGroup: string;
    workflowId: string;
    deadlineSeconds: number;
    x86CostUsd: number;
    arm64CostUsd: number;
    x86MakespanSeconds: number;
    arm64MakespanSeconds: number;
    x86DeadlineMet: boolean;
    arm64DeadlineMet: boolean;
    x86ResourceChoices: string;
    arm64ResourceChoices: string;
}

const resourceChoices = (output: ExperimentOutput): string => JSON.stringify(
    Object.fromEntries(output.taskAssignments.map(task => [task.taskId, task.resourceMode.id])),
);
const comparisons: ArchitectureComparison[] = [];
for (const comparisonGroup of [...comparisonBaselines.keys()].sort()) {
    const members = outputs.filter(output => output.comparisonGroup === comparisonGroup);
    const x86 = members.find(output => output.architectureRestriction === 'X86_64');
    const arm64 = members.find(output => output.architectureRestriction === 'ARM64');
    const joint = members.find(output => output.architectureRestriction === 'JOINT');
    if (!x86 || !arm64 || members.length !== (joint ? 3 : 2)) {
        throw new Error(
            `Comparison group ${comparisonGroup} must contain one X86_64, one ARM64, and optionally one JOINT run.`,
        );
    }
    comparisons.push({
        comparisonGroup,
        workflowId: x86.workflowId,
        deadlineSeconds: x86.deadlineSeconds,
        x86CostUsd: x86.estimatedExecutionCostUsd,
        arm64CostUsd: arm64.estimatedExecutionCostUsd,
        x86MakespanSeconds: x86.simulatedMakespanSeconds,
        arm64MakespanSeconds: arm64.simulatedMakespanSeconds,
        x86DeadlineMet: x86.deadlineMet,
        arm64DeadlineMet: arm64.deadlineMet,
        x86ResourceChoices: resourceChoices(x86),
        arm64ResourceChoices: resourceChoices(arm64),
    });
}

if (comparisons.length > 0) {
    let comparisonCsv = 'workflow,deadlineSeconds,x86OnlyCostUsd,arm64OnlyCostUsd,x86MakespanSeconds,arm64MakespanSeconds,x86DeadlineMet,arm64DeadlineMet,x86ResourceChoices,arm64ResourceChoices\n';
    for (const comparison of comparisons) {
        comparisonCsv += [
            comparison.workflowId,
            comparison.deadlineSeconds,
            comparison.x86CostUsd,
            comparison.arm64CostUsd,
            comparison.x86MakespanSeconds,
            comparison.arm64MakespanSeconds,
            comparison.x86DeadlineMet,
            comparison.arm64DeadlineMet,
            comparison.x86ResourceChoices,
            comparison.arm64ResourceChoices,
        ].map(csvCell).join(',') + '\n';
    }
    fs.writeFileSync(path.join(outputDir, 'architecture-comparison.csv'), comparisonCsv);

    let comparisonMarkdown = '| Workflow | Deadline | x86 cost | ARM64 cost | x86 makespan | ARM64 makespan | x86 compliant | ARM64 compliant |\n';
    comparisonMarkdown += '|---|---:|---:|---:|---:|---:|:---:|:---:|\n';
    for (const comparison of comparisons) {
        comparisonMarkdown += `| ${comparison.workflowId} | ${comparison.deadlineSeconds} s | ` +
            `$${comparison.x86CostUsd} | $${comparison.arm64CostUsd} | ` +
            `${comparison.x86MakespanSeconds} s | ${comparison.arm64MakespanSeconds} s | ` +
            `${comparison.x86DeadlineMet ? 'Yes' : 'No'} | ${comparison.arm64DeadlineMet ? 'Yes' : 'No'} |\n`;
    }
    fs.writeFileSync(path.join(outputDir, 'architecture-comparison.md'), comparisonMarkdown);
}

interface ArchFlowComparison {
    workflowId: string;
    deadlineSeconds: number;
    x86DeadlineMet: boolean;
    arm64DeadlineMet: boolean;
    bestFeasibleBaseline: ArchitectureRestriction | 'NONE';
    bestBaselineCostUsd?: number;
    bestBaselineMakespanSeconds?: number;
    archFlowCostUsd: number;
    archFlowMakespanSeconds: number;
    archFlowDeadlineMet: boolean;
    costReductionPercent?: number;
    architectureDistribution: string;
    selectedResourceModes: string;
}

const archFlowComparisons: ArchFlowComparison[] = [];
for (const comparisonGroup of [...comparisonBaselines.keys()].sort()) {
    const members = outputs.filter(output => output.comparisonGroup === comparisonGroup);
    const joint = members.find(output => output.architectureRestriction === 'JOINT');
    if (!joint) {
        continue;
    }
    const fixed = members.filter(output =>
        output.architectureRestriction === 'X86_64' || output.architectureRestriction === 'ARM64');
    const feasibleFixed = fixed.filter(output => output.deadlineMet).sort((a, b) =>
        a.estimatedExecutionCostUsd - b.estimatedExecutionCostUsd ||
        a.simulatedMakespanSeconds - b.simulatedMakespanSeconds ||
        a.architectureRestriction.localeCompare(b.architectureRestriction),
    );
    const best = feasibleFixed[0];
    const costReductionPercent = best && joint.deadlineMet
        ? 100 * (best.estimatedExecutionCostUsd - joint.estimatedExecutionCostUsd) /
            best.estimatedExecutionCostUsd
        : undefined;
    archFlowComparisons.push({
        workflowId: joint.workflowId,
        deadlineSeconds: joint.deadlineSeconds,
        x86DeadlineMet: fixed.find(item => item.architectureRestriction === 'X86_64')!.deadlineMet,
        arm64DeadlineMet: fixed.find(item => item.architectureRestriction === 'ARM64')!.deadlineMet,
        bestFeasibleBaseline: best?.architectureRestriction as ArchitectureRestriction | undefined ?? 'NONE',
        bestBaselineCostUsd: best?.estimatedExecutionCostUsd,
        bestBaselineMakespanSeconds: best?.simulatedMakespanSeconds,
        archFlowCostUsd: joint.estimatedExecutionCostUsd,
        archFlowMakespanSeconds: joint.simulatedMakespanSeconds,
        archFlowDeadlineMet: joint.deadlineMet,
        costReductionPercent,
        architectureDistribution: JSON.stringify(joint.architectureDistribution),
        selectedResourceModes: resourceChoices(joint),
    });
}

if (archFlowComparisons.length > 0) {
    const columns: Array<keyof ArchFlowComparison> = [
        'workflowId',
        'deadlineSeconds',
        'x86DeadlineMet',
        'arm64DeadlineMet',
        'bestFeasibleBaseline',
        'bestBaselineCostUsd',
        'bestBaselineMakespanSeconds',
        'archFlowCostUsd',
        'archFlowMakespanSeconds',
        'archFlowDeadlineMet',
        'costReductionPercent',
        'architectureDistribution',
        'selectedResourceModes',
    ];
    let csv = `${columns.join(',')}\n`;
    for (const comparison of archFlowComparisons) {
        csv += columns.map(column => csvCell(comparison[column] ?? '')).join(',') + '\n';
    }
    fs.writeFileSync(path.join(outputDir, 'archflow-comparison.csv'), csv);

    let markdown = '| Workflow | Deadline | Best feasible fixed baseline | Baseline cost | ArchFlow cost | ArchFlow makespan | ArchFlow compliant | Cost reduction |\n';
    markdown += '|---|---:|---|---:|---:|---:|:---:|---:|\n';
    for (const comparison of archFlowComparisons) {
        markdown += `| ${comparison.workflowId} | ${comparison.deadlineSeconds} s | ` +
            `${comparison.bestFeasibleBaseline} | ` +
            `${comparison.bestBaselineCostUsd === undefined ? 'N/A' : `$${comparison.bestBaselineCostUsd}`} | ` +
            `$${comparison.archFlowCostUsd} | ${comparison.archFlowMakespanSeconds} s | ` +
            `${comparison.archFlowDeadlineMet ? 'Yes' : 'No'} | ` +
            `${comparison.costReductionPercent === undefined ? 'N/A' : `${comparison.costReductionPercent}%`} |\n`;
    }
    fs.writeFileSync(path.join(outputDir, 'archflow-comparison.md'), markdown);
}

console.log(JSON.stringify(outputs.map(output => ({
    experimentId: output.experimentId,
    workflowId: output.workflowId,
    schedulerId: output.schedulerId,
    architectureRestriction: output.architectureRestriction,
    deadlineSeconds: output.deadlineSeconds,
    simulatedMakespanSeconds: output.simulatedMakespanSeconds,
    estimatedExecutionCostUsd: output.estimatedExecutionCostUsd,
    deadlineMet: output.deadlineMet,
    schedulingDecisionOverheadMs: output.schedulingDecisionOverheadMs,
    resourceModes: Object.fromEntries(output.taskAssignments.map(task => [task.taskId, task.resourceMode.id])),
})), null, 2));
