export type CpuArchitecture = 'x86_64' | 'arm64';

export type ArchitectureRestriction = 'X86_64' | 'ARM64';

export interface ArchitecturePriceRates {
    vCpuPerSecondUsd: number;
    memoryGbPerSecondUsd: number;
}

export interface FargatePricingConfig {
    schemaVersion: number;
    provider: 'aws-fargate';
    region: string;
    regionName: string;
    retrievedAt: string;
    currency: 'USD';
    operatingSystem: 'linux';
    minimumBillableSeconds: number;
    roundUpToSecond: boolean;
    billingStartsAtImageDownload: boolean;
    rates: Record<CpuArchitecture, ArchitecturePriceRates>;
    source: string;
    notes?: string;
}

export interface ResourceMode {
    id: string;
    architecture: CpuArchitecture;
    vCpu: number;
    memoryGb: number;
}

export interface ResourceModeCatalog {
    schemaVersion: number;
    source: string;
    retrievedAt: string;
    modes: ResourceMode[];
}

export type PerformanceProfileKind =
    | 'chunkfunc-proxy'
    | 'synthetic'
    | 'synthetic-arm64-derived'
    | 'measured-aws-fargate';

export interface PerformanceProfileProvenance {
    kind: PerformanceProfileKind;
    source: string;
    sourceProfileId?: string;
    sourceInputSizeBytes?: number;
    baselineArchitecture?: CpuArchitecture;
    basePerformanceFactor?: number;
    deterministicJitterFactor?: number;
    effectivePerformanceFactor?: number;
    randomSeed?: number;
    notes: string;
}

export interface TaskPerformanceProfile {
    resourceModeId: string;
    executionSeconds: number;
    startupOverheadSeconds: number;
    provenance: PerformanceProfileProvenance;
}

export interface WorkflowTask {
    id: string;
    taskClass: string;
    predecessorIds: string[];
    successorIds: string[];
    inputSizeBytes?: number;
    workloadSize?: number;
    profiles: TaskPerformanceProfile[];
}

export interface DagWorkflow {
    schemaVersion: number;
    id: string;
    deadlineSeconds: number;
    tasks: WorkflowTask[];
    provenance: string;
}

export interface TaskAssignment {
    taskId: string;
    taskClass: string;
    resourceMode: ResourceMode;
    executionSeconds: number;
    startupOverheadSeconds: number;
    simulatedDurationSeconds: number;
    startSeconds: number;
    finishSeconds: number;
    billableSeconds: number;
    estimatedCostUsd: number;
    profileProvenance: PerformanceProfileProvenance;
}

export interface WorkflowSimulationResult {
    workflowId: string;
    deadlineSeconds: number;
    simulatedMakespanSeconds: number;
    estimatedExecutionCostUsd: number;
    deadlineMet: boolean;
    taskAssignments: TaskAssignment[];
    dependencyCriticalPathTaskIds: string[];
}

export interface ScheduleResult extends WorkflowSimulationResult {
    schemaVersion: number;
    schedulerId: string;
    feasible: boolean;
    infeasibilityReason?: string;
    schedulingDecisionOverheadMs: number;
    selectionIterations: number;
}

export interface ArchFlowDecisionRecord {
    phase: 'deadline-improvement' | 'cost-refinement';
    taskId: string;
    fromResourceModeId: string;
    toResourceModeId: string;
    criticalPathBefore: string[];
    makespanBeforeSeconds: number;
    makespanAfterSeconds: number;
    costBeforeUsd: number;
    costAfterUsd: number;
}

export interface TaskSchedulingAnalysis {
    taskId: string;
    earliestPossibleStartSeconds: number;
    earliestPossibleFinishSeconds: number;
    fastestDownstreamPathSeconds: number;
    staticSlackSeconds: number;
    selectedSlackSeconds: number;
    finalCriticalPath: boolean;
}

export interface ArchFlowScheduleResult extends ScheduleResult {
    allowArchitectureSelection: boolean;
    fixedArchitecture: ArchitectureRestriction | null;
    architectureDistribution: Record<CpuArchitecture, number>;
    taskSchedulingAnalysis: TaskSchedulingAnalysis[];
    decisionTrace: ArchFlowDecisionRecord[];
}

export interface ArchFlowSchedulerOptions {
    allowArchitectureSelection: boolean;
    fixedArchitecture: ArchitectureRestriction | null;
}

export interface FargateCostBreakdown {
    actualDurationSeconds: number;
    billableSeconds: number;
    vCpuCostUsd: number;
    memoryCostUsd: number;
    totalCostUsd: number;
}
