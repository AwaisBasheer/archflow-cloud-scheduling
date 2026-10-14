import {
    FargateCostBreakdown,
    FargatePricingConfig,
    ResourceMode,
    ResourceModeCatalog,
} from './model';

const FLOAT_TOLERANCE = 1e-9;

function equals(a: number, b: number): boolean {
    return Math.abs(a - b) < FLOAT_TOLERANCE;
}

function isIntegerInRange(value: number, minimum: number, maximum: number, increment: number): boolean {
    if (value < minimum || value > maximum) {
        return false;
    }
    return equals((value - minimum) / increment, Math.round((value - minimum) / increment));
}

/** Validates the Linux task-level CPU/memory combinations documented by AWS Fargate. */
export function isValidLinuxFargateCombination(vCpu: number, memoryGb: number): boolean {
    if (equals(vCpu, 0.25)) {
        return [0.5, 1, 2].some(value => equals(value, memoryGb));
    }
    if (equals(vCpu, 0.5)) {
        return isIntegerInRange(memoryGb, 1, 4, 1);
    }
    if (equals(vCpu, 1)) {
        return isIntegerInRange(memoryGb, 2, 8, 1);
    }
    if (equals(vCpu, 2)) {
        return isIntegerInRange(memoryGb, 4, 16, 1);
    }
    if (equals(vCpu, 4)) {
        return isIntegerInRange(memoryGb, 8, 30, 1);
    }
    if (equals(vCpu, 8)) {
        return isIntegerInRange(memoryGb, 16, 60, 4);
    }
    if (equals(vCpu, 16)) {
        return isIntegerInRange(memoryGb, 32, 120, 8);
    }
    if (equals(vCpu, 32)) {
        return [60, 120, 244].includes(memoryGb);
    }
    return false;
}

export function validateResourceMode(mode: ResourceMode): void {
    if (!mode.id) {
        throw new Error('Resource mode ID must not be empty.');
    }
    if (mode.architecture !== 'x86_64' && mode.architecture !== 'arm64') {
        throw new Error(`Unsupported CPU architecture for resource mode ${mode.id}.`);
    }
    if (!isValidLinuxFargateCombination(mode.vCpu, mode.memoryGb)) {
        throw new Error(`Invalid Linux Fargate CPU/memory combination for ${mode.id}: ${mode.vCpu} vCPU, ${mode.memoryGb} GB.`);
    }
}

export function buildResourceModeMap(catalog: ResourceModeCatalog): Record<string, ResourceMode> {
    const modes: Record<string, ResourceMode> = {};
    for (const mode of catalog.modes) {
        validateResourceMode(mode);
        if (modes[mode.id]) {
            throw new Error(`Duplicate resource mode ID: ${mode.id}`);
        }
        modes[mode.id] = mode;
    }
    return modes;
}

export function validatePricingConfig(pricing: FargatePricingConfig): void {
    if (pricing.provider !== 'aws-fargate' || pricing.currency !== 'USD' || pricing.operatingSystem !== 'linux') {
        throw new Error('Only AWS Fargate Linux pricing in USD is supported.');
    }
    if (!Number.isFinite(pricing.minimumBillableSeconds) || pricing.minimumBillableSeconds <= 0) {
        throw new Error('minimumBillableSeconds must be positive.');
    }
    for (const architecture of ['x86_64', 'arm64'] as const) {
        const rate = pricing.rates[architecture];
        if (!rate || rate.vCpuPerSecondUsd < 0 || rate.memoryGbPerSecondUsd < 0) {
            throw new Error(`Missing or invalid ${architecture} pricing rates.`);
        }
    }
}

export function calculateFargateTaskCost(
    mode: ResourceMode,
    executionSeconds: number,
    startupOverheadSeconds: number,
    pricing: FargatePricingConfig,
): FargateCostBreakdown {
    validateResourceMode(mode);
    validatePricingConfig(pricing);
    if (!Number.isFinite(executionSeconds) || executionSeconds < 0) {
        throw new Error('executionSeconds must be a non-negative finite number.');
    }
    if (!Number.isFinite(startupOverheadSeconds) || startupOverheadSeconds < 0) {
        throw new Error('startupOverheadSeconds must be a non-negative finite number.');
    }

    const actualDurationSeconds = executionSeconds + startupOverheadSeconds;
    const minimumDuration = Math.max(actualDurationSeconds, pricing.minimumBillableSeconds);
    const billableSeconds = pricing.roundUpToSecond ? Math.ceil(minimumDuration) : minimumDuration;
    const rates = pricing.rates[mode.architecture];
    const vCpuCostUsd = mode.vCpu * rates.vCpuPerSecondUsd * billableSeconds;
    const memoryCostUsd = mode.memoryGb * rates.memoryGbPerSecondUsd * billableSeconds;

    return {
        actualDurationSeconds,
        billableSeconds,
        vCpuCostUsd,
        memoryCostUsd,
        totalCostUsd: vCpuCostUsd + memoryCostUsd,
    };
}
