import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { S3Client } from '@aws-sdk/client-s3';
import { FargateTaskRunner } from './fargate-runner';
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
    maxTotalTasks: 8,
    maxExperimentCostUsd: 10,
    maxAggregateCostUsd: 75,
    failureRateCutoff: 0.2,
    minimumAttemptsBeforeFailureRateCutoff: 5,
    consecutiveFailureCutoff: 3,
    ancillaryReservePerTaskUsd: 0.001,
};

const launchSpec: FargateLaunchSpec = {
    experimentId: 'callback-failure',
    runId: 'run-1',
    taskId: 'task-1',
    taskClass: 'transcode',
    cluster: 'cluster',
    taskDefinition: 'task-definition',
    containerName: 'ffmpeg',
    resourceMode: {
        id: 'x86-0.25-0.5',
        architecture: 'x86_64',
        cpuUnits: 256,
        memoryMiB: 512,
    },
    command: ['ffmpeg', '-version'],
    network: {
        subnetIds: ['subnet-1'],
        securityGroupIds: ['sg-1'],
        assignPublicIp: true,
    },
    logGroupName: '/archflow/test',
    logStreamPrefix: 'ecs',
    tags: {},
};

describe('FargateTaskRunner cleanup', () => {
    it('stops a submitted task when its submission-record callback fails', async () => {
        const send = jest.fn(async (command: unknown) => {
            if (command instanceof RunTaskCommand) {
                return {
                    tasks: [{
                        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-1',
                        taskDefinitionArn: 'task-definition',
                    }],
                };
            }
            if (command instanceof StopTaskCommand) {
                return {};
            }
            throw new Error('Unexpected AWS command');
        });
        const guardrail = new ExperimentCostGuardrail(config, prices);
        const runner = new FargateTaskRunner(
            { send } as unknown as ECSClient,
            { send: jest.fn() } as unknown as CloudWatchLogsClient,
            { send: jest.fn() } as unknown as S3Client,
            guardrail,
            prices,
            {
                pollIntervalMs: 1,
                maximumRuntimeSeconds: 900,
                ancillaryReservePerTaskUsd: 0.001,
                onTaskSubmitted: () => { throw new Error('ledger write failed'); },
            },
        );

        await expect(runner.run(launchSpec)).rejects.toThrow('ledger write failed');
        expect(send.mock.calls.some(([command]) => command instanceof StopTaskCommand)).toBe(true);
        expect(guardrail.current()).toMatchObject({ running: 0, failed: 1 });
    });
});
