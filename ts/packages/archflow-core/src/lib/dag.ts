import { DagWorkflow, WorkflowTask } from './model';

export function taskMapFor(workflow: DagWorkflow): Record<string, WorkflowTask> {
    const tasks: Record<string, WorkflowTask> = {};
    for (const task of workflow.tasks) {
        if (!task.id) {
            throw new Error('Task ID must not be empty.');
        }
        if (tasks[task.id]) {
            throw new Error(`Duplicate task ID: ${task.id}`);
        }
        tasks[task.id] = task;
    }
    return tasks;
}

export function topologicalOrder(workflow: DagWorkflow): string[] {
    const tasks = taskMapFor(workflow);
    const indegree: Record<string, number> = {};

    for (const task of workflow.tasks) {
        indegree[task.id] = task.predecessorIds.length;
        for (const predecessorId of task.predecessorIds) {
            const predecessor = tasks[predecessorId];
            if (!predecessor) {
                throw new Error(`Task ${task.id} references missing predecessor ${predecessorId}.`);
            }
            if (!predecessor.successorIds.includes(task.id)) {
                throw new Error(`Edge ${predecessorId} -> ${task.id} is missing from successorIds.`);
            }
        }
        for (const successorId of task.successorIds) {
            const successor = tasks[successorId];
            if (!successor) {
                throw new Error(`Task ${task.id} references missing successor ${successorId}.`);
            }
            if (!successor.predecessorIds.includes(task.id)) {
                throw new Error(`Edge ${task.id} -> ${successorId} is missing from predecessorIds.`);
            }
        }
    }

    const ready = Object.keys(tasks).filter(id => indegree[id] === 0).sort();
    const order: string[] = [];
    while (ready.length > 0) {
        const taskId = ready.shift()!;
        order.push(taskId);
        const successors = [...tasks[taskId].successorIds].sort();
        for (const successorId of successors) {
            indegree[successorId] -= 1;
            if (indegree[successorId] === 0) {
                ready.push(successorId);
                ready.sort();
            }
        }
    }

    if (order.length !== workflow.tasks.length) {
        throw new Error(`Workflow ${workflow.id} contains a cycle.`);
    }
    return order;
}

export function validateWorkflow(workflow: DagWorkflow): void {
    if (!workflow.id) {
        throw new Error('Workflow ID must not be empty.');
    }
    if (!Number.isFinite(workflow.deadlineSeconds) || workflow.deadlineSeconds <= 0) {
        throw new Error(`Workflow ${workflow.id} must have a positive deadline.`);
    }
    if (workflow.tasks.length === 0) {
        throw new Error(`Workflow ${workflow.id} must contain at least one task.`);
    }
    topologicalOrder(workflow);
    for (const task of workflow.tasks) {
        if (!task.taskClass) {
            throw new Error(`Task ${task.id} must have a taskClass.`);
        }
        if (task.inputSizeBytes === undefined && task.workloadSize === undefined) {
            throw new Error(`Task ${task.id} must define inputSizeBytes or workloadSize.`);
        }
        if (task.profiles.length === 0) {
            throw new Error(`Task ${task.id} has no performance profiles.`);
        }
        const profileIds = new Set<string>();
        for (const profile of task.profiles) {
            if (profileIds.has(profile.resourceModeId)) {
                throw new Error(`Task ${task.id} has duplicate profile ${profile.resourceModeId}.`);
            }
            profileIds.add(profile.resourceModeId);
            if (profile.executionSeconds < 0 || profile.startupOverheadSeconds < 0) {
                throw new Error(`Task ${task.id} contains a negative duration.`);
            }
        }
    }
}

export function longestPathDurationsFromTasks(
    workflow: DagWorkflow,
    durationByTaskId: Record<string, number>,
): Record<string, number> {
    const tasks = taskMapFor(workflow);
    const order = topologicalOrder(workflow).reverse();
    const longest: Record<string, number> = {};
    for (const taskId of order) {
        const task = tasks[taskId];
        const successorDuration = task.successorIds.length === 0
            ? 0
            : Math.max(...task.successorIds.map(successorId => longest[successorId]));
        longest[taskId] = durationByTaskId[taskId] + successorDuration;
    }
    return longest;
}
