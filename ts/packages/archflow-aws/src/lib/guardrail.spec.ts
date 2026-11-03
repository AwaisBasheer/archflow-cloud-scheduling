import { ExperimentCostGuardrail } from './guardrail';
import { AwsPriceRates, CostGuardrailConfig, FargateLaunchSpec } from './model';

const prices: AwsPriceRates = {
    x86VCpuHourUsd: 0.04048,
    x86MemoryGbHourUsd: 0.004445,
    armVCpuHourUsd: 0.03238,
    armMemoryGbHourUsd: 0.00356,
    publicIpv4HourUsd: 0.005,
    minimumBillableSeconds: 60,
};

const config: CostGuardrailConfig = {
    maxTaskRuntimeSeconds: 900,
    maxConcurrentTasks: 2,
    maxTotalTasks: 3,
    maxExperimentCostUsd: 10,
    maxAggregateCostUsd: 0.2,
    failureRateCutoff: 0.2,
    minimumAttemptsBeforeFailureRateCutoff: 5,
    consecutiveFailureCutoff: 3,
    ancillaryReservePerTaskUsd: 0.001,
};

function spec(id: string): FargateLaunchSpec {
    return {
        experimentId: 'test', runId: id, taskId: id, taskClass: 'transcode', cluster: 'c',
        taskDefinition: 'td', containerName: 'ffmpeg',
        resourceMode: { id: 'x86-4-8', architecture: 'x86_64', cpuUnits: 4096, memoryMiB: 8192 },
        command: [], network: { subnetIds: ['s'], securityGroupIds: ['g'], assignPublicIp: true },
        logGroupName: 'l', logStreamPrefix: 'p', tags: {},
    };
}

describe('ExperimentCostGuardrail', () => {
    it('reserves conservative cost before launch and releases it on completion', () => {
        const guardrail = new ExperimentCostGuardrail(config, prices);
        const bound = guardrail.admit(spec('one'));
        expect(bound).toBeGreaterThan(0.05);
        guardrail.launched(bound);
        expect(guardrail.current().running).toBe(1);
        expect(guardrail.current().committedUpperBoundUsd).toBeCloseTo(bound);
        guardrail.completed(bound, 0.004, true);
        expect(guardrail.current()).toMatchObject({ running: 0, succeeded: 1, failed: 0, accruedEstimatedUsd: 0.004 });
    });

    it('halts after the configured consecutive failures', () => {
        const guardrail = new ExperimentCostGuardrail(config, prices);
        for (let index = 0; index < 3; index += 1) {
            const bound = guardrail.admit(spec(String(index)));
            guardrail.launched(bound);
            guardrail.completed(bound, 0.001, false);
        }
        expect(guardrail.current().haltedReason).toContain('consecutive');
        expect(() => guardrail.admit(spec('blocked'))).toThrow('halted');
    });
});
