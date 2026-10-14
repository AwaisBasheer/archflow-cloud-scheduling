import { topologicalOrder, validateWorkflow } from './dag';
import { calculateFargateTaskCost } from './fargate';
import {
    DagWorkflow,
    FargatePricingConfig,
    ResourceMode,
    TaskAssignment,
    TaskPerformanceProfile,
    WorkflowSimulationResult,
} from './model';

export interface SimulationOptions {
    maxConcurrentTasks?: number;
}

interface RunningTask {
    taskId: string;
    finishSeconds: number;
}

export function simulateWorkflow(
    workflow: DagWorkflow,
    selectedProfiles: Record<string, TaskPerformanceProfile>,
    resourceModes: Record<string, ResourceMode>,
    pricing: FargatePricingConfig,
    options: SimulationOptions = {},
): WorkflowSimulationResult {
    validateWorkflow(workflow);
    const order = topologicalOrder(workflow);
    const orderIndex = new Map(order.map((taskId, index) => [taskId, index]));
    const tasks = new Map(workflow.tasks.map(task => [task.id, task]));
    const maxConcurrentTasks = options.maxConcurrentTasks ?? Number.POSITIVE_INFINITY;
    if (maxConcurrentTasks <= 0 || !Number.isFinite(maxConcurrentTasks) && maxConcurrentTasks !== Number.POSITIVE_INFINITY) {
        throw new Error('maxConcurrentTasks must be positive.');
    }

    const remainingPredecessors = new Map(workflow.tasks.map(task => [task.id, task.predecessorIds.length]));
    const ready = workflow.tasks.filter(task => task.predecessorIds.length === 0).map(task => task.id).sort();
    const running: RunningTask[] = [];
    const completed = new Set<string>();
    const assignments: Record<string, TaskAssignment> = {};
    let currentSeconds = 0;

    const startReadyTasks = (): void => {
        while (ready.length > 0 && running.length < maxConcurrentTasks) {
            const taskId = ready.shift()!;
            const task = tasks.get(taskId)!;
            const profile = selectedProfiles[taskId];
            if (!profile) {
                throw new Error(`No selected performance profile for task ${taskId}.`);
            }
            if (!task.profiles.some(candidate => candidate.resourceModeId === profile.resourceModeId)) {
                throw new Error(`Selected profile ${profile.resourceModeId} does not belong to task ${taskId}.`);
            }
            const mode = resourceModes[profile.resourceModeId];
            if (!mode) {
                throw new Error(`Unknown resource mode ${profile.resourceModeId} for task ${taskId}.`);
            }
            const cost = calculateFargateTaskCost(
                mode,
                profile.executionSeconds,
                profile.startupOverheadSeconds,
                pricing,
            );
            const finishSeconds = currentSeconds + cost.actualDurationSeconds;
            assignments[taskId] = {
                taskId,
                taskClass: task.taskClass,
                resourceMode: mode,
                executionSeconds: profile.executionSeconds,
                startupOverheadSeconds: profile.startupOverheadSeconds,
                simulatedDurationSeconds: cost.actualDurationSeconds,
                startSeconds: currentSeconds,
                finishSeconds,
                billableSeconds: cost.billableSeconds,
                estimatedCostUsd: cost.totalCostUsd,
                profileProvenance: profile.provenance,
            };
            running.push({ taskId, finishSeconds });
            running.sort((a, b) => a.finishSeconds - b.finishSeconds || a.taskId.localeCompare(b.taskId));
        }
    };

    startReadyTasks();
    while (completed.size < workflow.tasks.length) {
        if (running.length === 0) {
            throw new Error(`Workflow ${workflow.id} cannot make progress.`);
        }
        currentSeconds = running[0].finishSeconds;
        const finishing = running
            .filter(item => Math.abs(item.finishSeconds - currentSeconds) < 1e-9)
            .sort((a, b) => a.taskId.localeCompare(b.taskId));
        for (const item of finishing) {
            running.splice(running.findIndex(candidate => candidate.taskId === item.taskId), 1);
            completed.add(item.taskId);
            const task = tasks.get(item.taskId)!;
            for (const successorId of [...task.successorIds].sort()) {
                const remaining = remainingPredecessors.get(successorId)! - 1;
                remainingPredecessors.set(successorId, remaining);
                if (remaining === 0) {
                    ready.push(successorId);
                    ready.sort();
                }
            }
        }
        startReadyTasks();
    }

    const taskAssignments = Object.values(assignments).sort(
        (a, b) => orderIndex.get(a.taskId)! - orderIndex.get(b.taskId)!,
    );
    const simulatedMakespanSeconds = Math.max(...taskAssignments.map(item => item.finishSeconds));
    const estimatedExecutionCostUsd = taskAssignments.reduce((sum, item) => sum + item.estimatedCostUsd, 0);

    return {
        workflowId: workflow.id,
        deadlineSeconds: workflow.deadlineSeconds,
        simulatedMakespanSeconds,
        estimatedExecutionCostUsd,
        deadlineMet: simulatedMakespanSeconds <= workflow.deadlineSeconds,
        taskAssignments,
        dependencyCriticalPathTaskIds: findDependencyCriticalPath(workflow, assignments),
    };
}

function findDependencyCriticalPath(
    workflow: DagWorkflow,
    assignments: Record<string, TaskAssignment>,
): string[] {
    const tasks = new Map(workflow.tasks.map(task => [task.id, task]));
    const finalTask = [...workflow.tasks]
        .sort((a, b) => assignments[b.id].finishSeconds - assignments[a.id].finishSeconds || a.id.localeCompare(b.id))[0];
    const reversedPath = [finalTask.id];
    let currentTask = finalTask;
    while (currentTask.predecessorIds.length > 0) {
        const predecessorId = [...currentTask.predecessorIds].sort((a, b) =>
            assignments[b].finishSeconds - assignments[a].finishSeconds || a.localeCompare(b),
        )[0];
        reversedPath.push(predecessorId);
        currentTask = tasks.get(predecessorId)!;
    }
    return reversedPath.reverse();
}
