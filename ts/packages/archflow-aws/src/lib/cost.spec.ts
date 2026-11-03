import { calculateLifecycleDurations, estimateProviderCost } from './cost';

describe('real Fargate lifecycle cost', () => {
    it('uses observed timestamps and the Linux 60-second minimum', () => {
        const durations = calculateLifecycleDurations({
            submittedAt: '2026-10-10T00:00:00.000Z',
            createdAt: '2026-10-10T00:00:01.000Z',
            pullStartedAt: '2026-10-10T00:00:02.000Z',
            pullStoppedAt: '2026-10-10T00:00:12.000Z',
            startedAt: '2026-10-10T00:00:13.000Z',
            executionStoppedAt: '2026-10-10T00:00:32.100Z',
            stoppedAt: '2026-10-10T00:00:34.000Z',
            applicationStartedAt: '2026-10-10T00:00:14.000Z',
            applicationEndedAt: '2026-10-10T00:00:30.000Z',
        }, 60);
        expect(durations).toMatchObject({
            applicationSeconds: 16,
            imagePullSeconds: 10,
            initializationSeconds: 12,
            fullLifecycleSeconds: 34,
            providerMeteredSeconds: 32,
            billableSeconds: 60,
        });
        const cost = estimateProviderCost(
            { id: 'arm-1-2', architecture: 'arm64', cpuUnits: 1024, memoryMiB: 2048 },
            durations,
            {
                x86VCpuHourUsd: 0.04048, x86MemoryGbHourUsd: 0.004445,
                armVCpuHourUsd: 0.03238, armMemoryGbHourUsd: 0.00356,
                publicIpv4HourUsd: 0.005, minimumBillableSeconds: 60,
            },
        );
        expect(cost.computeUsd).toBeCloseTo(0.0005396666667);
        expect(cost.memoryUsd).toBeCloseTo(0.0001186666667);
        expect(cost.publicIpv4Usd).toBeCloseTo(0.0000472222222);
    });

    it('does not charge for a public IPv4 address when none is assigned', () => {
        const cost = estimateProviderCost(
            { id: 'x86-0.25-0.5', architecture: 'x86_64', cpuUnits: 256, memoryMiB: 512 },
            { fullLifecycleSeconds: 60, billableSeconds: 60 },
            {
                x86VCpuHourUsd: 0.04048, x86MemoryGbHourUsd: 0.004445,
                armVCpuHourUsd: 0.03238, armMemoryGbHourUsd: 0.00356,
                publicIpv4HourUsd: 0.005, minimumBillableSeconds: 60,
            },
            0,
            false,
        );

        expect(cost.publicIpv4Usd).toBe(0);
    });
});
