import { CpuArchitecture } from '@archflow/core';

export interface AwsPriceRates {
    x86VCpuHourUsd: number;
    x86MemoryGbHourUsd: number;
    armVCpuHourUsd: number;
    armMemoryGbHourUsd: number;
    publicIpv4HourUsd: number;
    minimumBillableSeconds: number;
}

export interface RealResourceMode {
    id: string;
    architecture: CpuArchitecture;
    cpuUnits: number;
    memoryMiB: number;
}

export interface CostGuardrailConfig {
    maxTaskRuntimeSeconds: number;
    maxConcurrentTasks: number;
    maxTotalTasks: number;
    maxExperimentCostUsd: number;
    maxAggregateCostUsd: number;
    failureRateCutoff: number;
    minimumAttemptsBeforeFailureRateCutoff: number;
    consecutiveFailureCutoff: number;
    ancillaryReservePerTaskUsd: number;
}

export interface AwsNetworkConfig {
    subnetIds: string[];
    securityGroupIds: string[];
    assignPublicIp: boolean;
}

export interface ExpectedOutput {
    bucket: string;
    key: string;
    minimumBytes?: number;
}

export interface FargateLaunchSpec {
    experimentId: string;
    runId: string;
    taskId: string;
    taskClass: string;
    cluster: string;
    taskDefinition: string;
    containerName: string;
    resourceMode: RealResourceMode;
    command: string[];
    environment?: Record<string, string>;
    network: AwsNetworkConfig;
    logGroupName: string;
    logStreamPrefix: string;
    expectedOutputs?: ExpectedOutput[];
    tags: Record<string, string>;
}

export interface LifecycleTimestamps {
    submittedAt: string;
    createdAt?: string;
    pullStartedAt?: string;
    pullStoppedAt?: string;
    startedAt?: string;
    executionStoppedAt?: string;
    stoppedAt?: string;
    applicationStartedAt?: string;
    applicationEndedAt?: string;
}

export interface LifecycleDurations {
    applicationSeconds?: number;
    imagePullSeconds?: number;
    initializationSeconds?: number;
    fullLifecycleSeconds?: number;
    providerMeteredSeconds?: number;
    billableSeconds?: number;
}

export interface ProviderCostEstimate {
    basis: 'public-price-list-calculation';
    computeUsd: number;
    memoryUsd: number;
    publicIpv4Usd: number;
    ancillaryReserveUsd: number;
    totalUsd: number;
}

export interface OutputValidation {
    bucket: string;
    key: string;
    exists: boolean;
    sizeBytes?: number;
    etag?: string;
    checksumSha256?: string;
    error?: string;
}

export interface FargateTaskRecord {
    schemaVersion: 1;
    experimentId: string;
    runId: string;
    taskId: string;
    taskClass: string;
    taskArn?: string;
    taskDefinitionArn?: string;
    architecture: CpuArchitecture;
    cpuUnits: number;
    memoryMiB: number;
    actualArchitecture?: string;
    ffmpegVersion?: string;
    lastStatus: string;
    stoppedReason?: string;
    stopCode?: string;
    exitCode?: number;
    containerReason?: string;
    lifecycle: LifecycleTimestamps;
    durations: LifecycleDurations;
    cost: ProviderCostEstimate;
    outputValidation: OutputValidation[];
    logStreamName?: string;
    logMessages: string[];
    successful: boolean;
    timedOut: boolean;
}

export interface WorkflowNode {
    id: string;
    predecessorIds: string[];
    launchSpec: FargateLaunchSpec;
}

export interface RealWorkflowResult {
    schemaVersion: 1;
    workflowId: string;
    schedulerId: string;
    deadlineSeconds: number;
    orchestratorStartedAt: string;
    orchestratorEndedAt: string;
    makespanSeconds: number;
    deadlineMet: boolean;
    deadlineLatenessSeconds: number;
    successful: boolean;
    taskRecords: FargateTaskRecord[];
    estimatedProviderCostUsd: number;
    schedulerDecisionOverheadMs: number;
}
