import { AwsPriceRates, LifecycleDurations, ProviderCostEstimate, RealResourceMode } from './model';

export function secondsBetween(start?: string, end?: string): number | undefined {
    if (!start || !end) {
        return undefined;
    }
    const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function calculateLifecycleDurations(
    timestamps: {
        submittedAt: string;
        createdAt?: string;
        pullStartedAt?: string;
        pullStoppedAt?: string;
        startedAt?: string;
        executionStoppedAt?: string;
        stoppedAt?: string;
        applicationStartedAt?: string;
        applicationEndedAt?: string;
    },
    minimumBillableSeconds: number,
): LifecycleDurations {
    const providerStart = timestamps.pullStartedAt ?? timestamps.createdAt;
    const providerEnd = timestamps.stoppedAt ?? timestamps.executionStoppedAt;
    const providerMeteredSeconds = secondsBetween(providerStart, providerEnd);
    return {
        applicationSeconds: secondsBetween(timestamps.applicationStartedAt, timestamps.applicationEndedAt),
        imagePullSeconds: secondsBetween(timestamps.pullStartedAt, timestamps.pullStoppedAt),
        initializationSeconds: secondsBetween(timestamps.createdAt, timestamps.startedAt),
        fullLifecycleSeconds: secondsBetween(timestamps.submittedAt, timestamps.stoppedAt),
        providerMeteredSeconds,
        billableSeconds: providerMeteredSeconds === undefined
            ? undefined
            : Math.ceil(Math.max(minimumBillableSeconds, providerMeteredSeconds)),
    };
}

export function estimateProviderCost(
    mode: RealResourceMode,
    durations: LifecycleDurations,
    prices: AwsPriceRates,
    ancillaryReserveUsd = 0,
    usesPublicIpv4 = true,
): ProviderCostEstimate {
    const billableSeconds = durations.billableSeconds ?? prices.minimumBillableSeconds;
    const lifecycleSeconds = durations.fullLifecycleSeconds ?? billableSeconds;
    const vCpu = mode.cpuUnits / 1024;
    const memoryGb = mode.memoryMiB / 1024;
    const cpuRate = mode.architecture === 'arm64' ? prices.armVCpuHourUsd : prices.x86VCpuHourUsd;
    const memoryRate = mode.architecture === 'arm64' ? prices.armMemoryGbHourUsd : prices.x86MemoryGbHourUsd;
    const computeUsd = vCpu * cpuRate * billableSeconds / 3600;
    const memoryUsd = memoryGb * memoryRate * billableSeconds / 3600;
    const publicIpv4Usd = usesPublicIpv4 ? prices.publicIpv4HourUsd * lifecycleSeconds / 3600 : 0;
    return {
        basis: 'public-price-list-calculation',
        computeUsd,
        memoryUsd,
        publicIpv4Usd,
        ancillaryReserveUsd,
        totalUsd: computeUsd + memoryUsd + publicIpv4Usd + ancillaryReserveUsd,
    };
}

export function conservativeTaskUpperBoundUsd(
    mode: RealResourceMode,
    maximumRuntimeSeconds: number,
    prices: AwsPriceRates,
    ancillaryReserveUsd: number,
): number {
    const durations: LifecycleDurations = {
        fullLifecycleSeconds: maximumRuntimeSeconds,
        providerMeteredSeconds: maximumRuntimeSeconds,
        billableSeconds: Math.ceil(Math.max(prices.minimumBillableSeconds, maximumRuntimeSeconds)),
    };
    return estimateProviderCost(mode, durations, prices, ancillaryReserveUsd).totalUsd;
}
