import {
    FargatePricingConfig,
    ResourceMode,
    TaskPerformanceProfile,
} from './model';

export const TEST_PRICING: FargatePricingConfig = {
    schemaVersion: 1,
    provider: 'aws-fargate',
    region: 'us-east-1',
    regionName: 'US East (N. Virginia)',
    retrievedAt: '2026-10-10',
    currency: 'USD',
    operatingSystem: 'linux',
    minimumBillableSeconds: 60,
    roundUpToSecond: true,
    billingStartsAtImageDownload: true,
    rates: {
        x86_64: {
            vCpuPerSecondUsd: 0.000011244,
            memoryGbPerSecondUsd: 0.000001235,
        },
        arm64: {
            vCpuPerSecondUsd: 0.0000089944,
            memoryGbPerSecondUsd: 0.0000009889,
        },
    },
    source: 'https://aws.amazon.com/fargate/pricing/',
};

export const TEST_MODES: Record<string, ResourceMode> = {
    small: { id: 'small', architecture: 'x86_64', vCpu: 0.25, memoryGb: 0.5 },
    medium: { id: 'medium', architecture: 'x86_64', vCpu: 0.5, memoryGb: 1 },
    large: { id: 'large', architecture: 'x86_64', vCpu: 1, memoryGb: 2 },
    xlarge: { id: 'xlarge', architecture: 'x86_64', vCpu: 2, memoryGb: 4 },
    xxlarge: { id: 'xxlarge', architecture: 'x86_64', vCpu: 4, memoryGb: 8 },
    'arm-small': { id: 'arm-small', architecture: 'arm64', vCpu: 0.25, memoryGb: 0.5 },
    'arm-medium': { id: 'arm-medium', architecture: 'arm64', vCpu: 0.5, memoryGb: 1 },
    'arm-large': { id: 'arm-large', architecture: 'arm64', vCpu: 1, memoryGb: 2 },
    'arm-xlarge': { id: 'arm-xlarge', architecture: 'arm64', vCpu: 2, memoryGb: 4 },
    'arm-xxlarge': { id: 'arm-xxlarge', architecture: 'arm64', vCpu: 4, memoryGb: 8 },
};

export function testProfile(
    resourceModeId: string,
    executionSeconds: number,
    startupOverheadSeconds = 0,
): TaskPerformanceProfile {
    return {
        resourceModeId,
        executionSeconds,
        startupOverheadSeconds,
        provenance: {
            kind: 'synthetic',
            source: 'unit-test',
            notes: 'Unit-test fixture.',
        },
    };
}
