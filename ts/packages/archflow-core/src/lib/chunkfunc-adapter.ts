import { DagWorkflow, ResourceMode, TaskPerformanceProfile, WorkflowTask } from './model';

interface ChunkFuncResourceProfile {
    memoryMiB: number;
    milliCpu: number;
}

interface ChunkFuncProfilingResult {
    executionTimeMs: number;
    inputSizeBytes: number;
    statusCode: number;
}

interface ChunkFuncProfileResults {
    resourceProfileId: string;
    results?: ChunkFuncProfilingResult[];
}

interface ChunkFuncProfilingSession {
    results: ChunkFuncProfileResults[];
}

interface ChunkFuncStepDescription {
    name: string;
    type: string;
    successors?: string[];
    profilingResults?: ChunkFuncProfilingSession;
    exhaustiveProfilingResults?: ChunkFuncProfilingSession;
}

export interface ChunkFuncWorkflowDescription {
    name: string;
    startStep: string;
    endStep: string;
    availableResourceProfiles: ChunkFuncResourceProfile[];
    steps: ChunkFuncStepDescription[];
}

export interface ChunkFuncExecutionDescription {
    scenarioName: string;
    inputSizeBytes: number;
    sloLimit?: number;
    maxResponseTimeMs?: number;
    stepExecutions: Record<string, { outputSizeBytes: number }>;
}

export interface ChunkFuncProxyMapping {
    schemaVersion: number;
    startupOverheadSeconds: number;
    modeToChunkFuncProfile: Record<string, string>;
    taskClassAliases: Record<string, string>;
    provenance: string;
}

export function adaptChunkFuncWorkflow(
    workflowDescription: ChunkFuncWorkflowDescription,
    executionDescription: ChunkFuncExecutionDescription,
    modes: Record<string, ResourceMode>,
    mapping: ChunkFuncProxyMapping,
    deadlineSeconds?: number,
): DagWorkflow {
    const predecessorIds: Record<string, string[]> = {};
    for (const step of workflowDescription.steps) {
        predecessorIds[step.name] = [];
    }
    for (const step of workflowDescription.steps) {
        for (const successorId of step.successors ?? []) {
            if (!predecessorIds[successorId]) {
                throw new Error(`ChunkFunc step ${step.name} references missing successor ${successorId}.`);
            }
            predecessorIds[successorId].push(step.name);
        }
    }

    const tasks: WorkflowTask[] = workflowDescription.steps.map(step => {
        if (step.type !== 'function' || !step.profilingResults) {
            throw new Error(`Phase 3 adapter supports profiled function steps only: ${step.name}.`);
        }
        const taskPredecessors = predecessorIds[step.name].sort();
        const inputSizeBytes = taskPredecessors.length === 0
            ? executionDescription.inputSizeBytes
            : taskPredecessors.reduce(
                (sum, predecessorId) => sum + executionDescription.stepExecutions[predecessorId].outputSizeBytes,
                0,
            );
        const performanceSource = step.exhaustiveProfilingResults ?? step.profilingResults;
        const profiles = Object.entries(mapping.modeToChunkFuncProfile).map(([modeId, sourceProfileId]) => {
            if (!modes[modeId]) {
                throw new Error(`Proxy mapping references unknown resource mode ${modeId}.`);
            }
            const sourceResults = performanceSource.results.find(result => result.resourceProfileId === sourceProfileId);
            if (!sourceResults?.results || sourceResults.results.length === 0) {
                throw new Error(`No ChunkFunc results for ${step.name}/${sourceProfileId}.`);
            }
            const result = findResultForInput(inputSizeBytes, sourceResults.results);
            const profile: TaskPerformanceProfile = {
                resourceModeId: modeId,
                executionSeconds: result.executionTimeMs / 1000,
                startupOverheadSeconds: mapping.startupOverheadSeconds,
                provenance: {
                    kind: 'chunkfunc-proxy',
                    source: `${workflowDescription.name}/${executionDescription.scenarioName}/${step.name}`,
                    sourceProfileId,
                    sourceInputSizeBytes: result.inputSizeBytes,
                    notes: mapping.provenance,
                },
            };
            return profile;
        });
        return {
            id: step.name,
            taskClass: mapping.taskClassAliases[step.name] ?? step.name,
            predecessorIds: taskPredecessors,
            successorIds: [...(step.successors ?? [])].sort(),
            inputSizeBytes,
            profiles,
        };
    });

    const sourceDeadlineMs = executionDescription.sloLimit ?? executionDescription.maxResponseTimeMs;
    const resolvedDeadlineSeconds = deadlineSeconds ?? (sourceDeadlineMs === undefined ? undefined : sourceDeadlineMs / 1000);
    if (resolvedDeadlineSeconds === undefined) {
        throw new Error('No workflow deadline was supplied by the adapter or scenario.');
    }

    return {
        schemaVersion: 1,
        id: `vidpro-${executionDescription.scenarioName}-fargate-proxy`,
        deadlineSeconds: resolvedDeadlineSeconds,
        tasks,
        provenance: `Adapted from original ChunkFunc ${workflowDescription.name}/${executionDescription.scenarioName}. Timing values are deterministic workload proxies and are not Fargate x86 measurements.`,
    };
}

function findResultForInput(
    inputSizeBytes: number,
    profileResults: ChunkFuncProfilingResult[],
): ChunkFuncProfilingResult {
    const successful = profileResults
        .filter(result => result.statusCode >= 200 && result.statusCode <= 299)
        .sort((a, b) => a.inputSizeBytes - b.inputSizeBytes);
    const matching = successful.find(result => inputSizeBytes <= result.inputSizeBytes);
    if (matching) {
        return matching;
    }
    const largest = successful[successful.length - 1];
    if (!largest) {
        throw new Error(`No successful profiling result for input ${inputSizeBytes}.`);
    }
    return largest;
}
