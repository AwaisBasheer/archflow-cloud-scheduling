import { executeRealDag, TaskExecutor } from './dag-orchestrator';
import { FargateTaskRecord, WorkflowNode } from './model';

function record(id: string): FargateTaskRecord {
    return {
        schemaVersion: 1, experimentId: 'e', runId: id, taskId: id, taskClass: 'c',
        architecture: 'x86_64', cpuUnits: 256, memoryMiB: 512, lastStatus: 'STOPPED',
        lifecycle: { submittedAt: new Date().toISOString() }, durations: {},
        cost: { basis: 'public-price-list-calculation', computeUsd: 0.1, memoryUsd: 0, publicIpv4Usd: 0, ancillaryReserveUsd: 0, totalUsd: 0.1 },
        outputValidation: [], logMessages: [], successful: true, timedOut: false,
    };
}

function node(id: string, predecessors: string[]): WorkflowNode {
    return {
        id, predecessorIds: predecessors,
        launchSpec: {
            experimentId: 'e', runId: id, taskId: id, taskClass: 'c', cluster: 'c', taskDefinition: 't',
            containerName: 'x', resourceMode: { id: 'm', architecture: 'x86_64', cpuUnits: 256, memoryMiB: 512 },
            command: [], network: { subnetIds: ['s'], securityGroupIds: ['g'], assignPublicIp: true },
            logGroupName: 'l', logStreamPrefix: 'p', tags: {},
        },
    };
}

describe('executeRealDag', () => {
    it('runs only dependency-ready nodes and includes all task costs', async () => {
        const order: string[] = [];
        const executor: TaskExecutor = {
            execute: async item => {
                order.push(item.id);
                return record(item.id);
            },
            stopTracked: async () => undefined,
        };
        const result = await executeRealDag(
            [node('root', []), node('left', ['root']), node('right', ['root']), node('join', ['left', 'right'])],
            executor,
            { workflowId: 'w', schedulerId: 's', deadlineSeconds: 60, schedulerDecisionOverheadMs: 1, maxConcurrentTasks: 2 },
        );
        expect(order[0]).toBe('root');
        expect(order.at(-1)).toBe('join');
        expect(new Set(order.slice(1, 3))).toEqual(new Set(['left', 'right']));
        expect(result.estimatedProviderCostUsd).toBeCloseTo(0.4);
        expect(result.successful).toBe(true);
    });
});
