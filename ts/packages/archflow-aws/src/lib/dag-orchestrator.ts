import { performance } from 'node:perf_hooks';
import { FargateTaskRecord, RealWorkflowResult, WorkflowNode } from './model';

export interface TaskExecutor {
    execute(node: WorkflowNode): Promise<FargateTaskRecord>;
    stopTracked(reason: string): Promise<void>;
}

export interface WorkflowExecutionOptions {
    workflowId: string;
    schedulerId: string;
    deadlineSeconds: number;
    schedulerDecisionOverheadMs: number;
    maxConcurrentTasks: number;
}

export async function executeRealDag(
    nodes: WorkflowNode[],
    executor: TaskExecutor,
    options: WorkflowExecutionOptions,
): Promise<RealWorkflowResult> {
    const orchestrationClock = performance.now();
    const orchestratorStartedAt = new Date().toISOString();
    const byId = new Map(nodes.map(node => [node.id, node]));
    if (byId.size !== nodes.length) {
        throw new Error('Workflow contains duplicate task IDs.');
    }
    for (const node of nodes) {
        for (const predecessorId of node.predecessorIds) {
            if (!byId.has(predecessorId)) {
                throw new Error(`Task ${node.id} references missing predecessor ${predecessorId}.`);
            }
        }
    }

    const pending = new Set(nodes.map(node => node.id));
    const running = new Map<string, Promise<{ id: string; record: FargateTaskRecord }>>();
    const records = new Map<string, FargateTaskRecord>();

    try {
        while (pending.size > 0 || running.size > 0) {
            const ready = [...pending]
                .filter(id => byId.get(id)!.predecessorIds.every(parent => records.get(parent)?.successful))
                .sort();
            while (ready.length > 0 && running.size < options.maxConcurrentTasks) {
                const id = ready.shift()!;
                pending.delete(id);
                const promise = executor.execute(byId.get(id)!).then(record => ({ id, record }));
                running.set(id, promise);
            }
            if (running.size === 0) {
                const failedParents = [...pending].filter(id =>
                    byId.get(id)!.predecessorIds.some(parent => records.has(parent) && !records.get(parent)!.successful));
                if (failedParents.length > 0) {
                    throw new Error(`Dependencies failed for: ${failedParents.join(', ')}`);
                }
                throw new Error('Workflow cannot make progress; the DAG may contain a cycle.');
            }
            const finished = await Promise.race(running.values());
            running.delete(finished.id);
            records.set(finished.id, finished.record);
            if (!finished.record.successful) {
                throw new Error(`Task ${finished.id} failed.`);
            }
        }
    } catch (error) {
        await executor.stopTracked(`Workflow aborted: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }

    const orchestratorEndedAt = new Date().toISOString();
    const makespanSeconds = (performance.now() - orchestrationClock) / 1000;
    const taskRecords = nodes.map(node => records.get(node.id)!);
    return {
        schemaVersion: 1,
        workflowId: options.workflowId,
        schedulerId: options.schedulerId,
        deadlineSeconds: options.deadlineSeconds,
        orchestratorStartedAt,
        orchestratorEndedAt,
        makespanSeconds,
        deadlineMet: makespanSeconds <= options.deadlineSeconds,
        deadlineLatenessSeconds: Math.max(0, makespanSeconds - options.deadlineSeconds),
        successful: taskRecords.every(record => record.successful),
        taskRecords,
        estimatedProviderCostUsd: taskRecords.reduce((sum, record) => sum + record.cost.totalUsd, 0),
        schedulerDecisionOverheadMs: options.schedulerDecisionOverheadMs,
    };
}
