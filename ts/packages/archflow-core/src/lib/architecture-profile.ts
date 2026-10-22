import {
    ArchitectureRestriction,
    DagWorkflow,
    ResourceMode,
    TaskPerformanceProfile,
} from './model';
import { cpuArchitectureFor } from './x86-scheduler';

export interface ArchitecturePerformanceProfileSet {
    description: string;
    baselineArchitecture: 'X86_64';
    targetArchitecture: 'ARM64';
    defaultExecutionTimeFactor: number;
    taskClassExecutionTimeFactors: Record<string, number>;
    deterministicJitterFraction: number;
}

export interface ArchitecturePerformanceConfig {
    schemaVersion: number;
    randomSeed: number;
    factorMeaning: string;
    derivation: string;
    profileSets: Record<string, ArchitecturePerformanceProfileSet>;
}

function stableUnitInterval(seed: number, key: string): number {
    let hash = (2166136261 ^ seed) >>> 0;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash / 0xffffffff;
}

function rounded(value: number): number {
    return Number(value.toFixed(9));
}

function correspondingMode(
    sourceMode: ResourceMode,
    target: ArchitectureRestriction,
    resourceModes: Record<string, ResourceMode>,
): ResourceMode {
    const targetArchitecture = cpuArchitectureFor(target);
    const matching = Object.values(resourceModes).filter(mode =>
        mode.architecture === targetArchitecture &&
        mode.vCpu === sourceMode.vCpu &&
        mode.memoryGb === sourceMode.memoryGb,
    );
    if (matching.length !== 1) {
        throw new Error(
            `Expected one ${targetArchitecture} mode matching ${sourceMode.vCpu} vCPU / ` +
            `${sourceMode.memoryGb} GB, found ${matching.length}.`,
        );
    }
    return matching[0];
}

export function deriveArm64Workflow(
    baseline: DagWorkflow,
    resourceModes: Record<string, ResourceMode>,
    config: ArchitecturePerformanceConfig,
    profileSetId: string,
): DagWorkflow {
    const profileSet = config.profileSets[profileSetId];
    if (!profileSet) {
        throw new Error(`Unknown architecture performance profile set: ${profileSetId}.`);
    }
    if (profileSet.baselineArchitecture !== 'X86_64' || profileSet.targetArchitecture !== 'ARM64') {
        throw new Error(`Profile set ${profileSetId} must derive ARM64 profiles from X86_64 profiles.`);
    }
    if (profileSet.deterministicJitterFraction < 0 || profileSet.deterministicJitterFraction >= 1) {
        throw new Error(`Profile set ${profileSetId} has an invalid deterministic jitter fraction.`);
    }

    return {
        ...baseline,
        provenance: `${baseline.provenance} ARM64 timings are synthetic derivatives from profile set ${profileSetId}.`,
        tasks: baseline.tasks.map(task => ({
            ...task,
            predecessorIds: [...task.predecessorIds],
            successorIds: [...task.successorIds],
            profiles: task.profiles
                .filter(profile => resourceModes[profile.resourceModeId]?.architecture === 'x86_64')
                .map((profile): TaskPerformanceProfile => {
                    const sourceMode = resourceModes[profile.resourceModeId];
                    if (!sourceMode) {
                        throw new Error(`Unknown source resource mode ${profile.resourceModeId}.`);
                    }
                    const targetMode = correspondingMode(sourceMode, 'ARM64', resourceModes);
                    const baseFactor = profileSet.taskClassExecutionTimeFactors[task.taskClass]
                        ?? profileSet.defaultExecutionTimeFactor;
                    const randomValue = stableUnitInterval(
                        config.randomSeed,
                        `${profileSetId}|${baseline.id}|${task.id}|${profile.resourceModeId}`,
                    );
                    const jitterFactor = rounded(
                        1 + (2 * randomValue - 1) * profileSet.deterministicJitterFraction,
                    );
                    const effectiveFactor = rounded(baseFactor * jitterFactor);
                    return {
                        resourceModeId: targetMode.id,
                        executionSeconds: rounded(profile.executionSeconds * effectiveFactor),
                        startupOverheadSeconds: profile.startupOverheadSeconds,
                        provenance: {
                            kind: 'synthetic-arm64-derived',
                            source: profileSetId,
                            sourceProfileId: profile.resourceModeId,
                            sourceInputSizeBytes: profile.provenance.sourceInputSizeBytes,
                            baselineArchitecture: 'x86_64',
                            basePerformanceFactor: baseFactor,
                            deterministicJitterFactor: jitterFactor,
                            effectivePerformanceFactor: effectiveFactor,
                            randomSeed: config.randomSeed,
                            notes: `${profileSet.description} Factor multiplies x86 execution time; startup overhead is unchanged.`,
                        },
                    };
                }),
        })),
    };
}

export function buildJointArchitectureWorkflow(
    baseline: DagWorkflow,
    resourceModes: Record<string, ResourceMode>,
    config: ArchitecturePerformanceConfig,
    profileSetId: string,
): DagWorkflow {
    const arm64 = deriveArm64Workflow(baseline, resourceModes, config, profileSetId);
    assertComparableWorkflowInputs(baseline, arm64);
    return {
        ...baseline,
        provenance: `${baseline.provenance} Joint x86_64/ARM64 candidates use synthetic ARM64 profile set ${profileSetId}.`,
        tasks: baseline.tasks.map((task, index) => ({
            ...task,
            predecessorIds: [...task.predecessorIds],
            successorIds: [...task.successorIds],
            profiles: [
                ...task.profiles.filter(profile =>
                    resourceModes[profile.resourceModeId]?.architecture === 'x86_64'),
                ...arm64.tasks[index].profiles,
            ],
        })),
    };
}

export function assertComparableWorkflowInputs(baseline: DagWorkflow, candidate: DagWorkflow): void {
    if (baseline.id !== candidate.id || baseline.deadlineSeconds !== candidate.deadlineSeconds) {
        throw new Error('Architecture comparison changed workflow identity or deadline.');
    }
    const taskInput = (workflow: DagWorkflow) => workflow.tasks.map(task => ({
        id: task.id,
        taskClass: task.taskClass,
        predecessorIds: task.predecessorIds,
        successorIds: task.successorIds,
        inputSizeBytes: task.inputSizeBytes,
        workloadSize: task.workloadSize,
    }));
    if (JSON.stringify(taskInput(baseline)) !== JSON.stringify(taskInput(candidate))) {
        throw new Error('Architecture comparison changed the DAG, task classes, or task inputs.');
    }
}
