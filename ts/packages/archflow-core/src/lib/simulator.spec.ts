import { DagWorkflow, TaskPerformanceProfile } from './model';
import { simulateWorkflow } from './simulator';
import { TEST_MODES, TEST_PRICING, testProfile } from './test-fixtures';

function parallelWorkflow(deadlineSeconds: number): DagWorkflow {
    return {
        schemaVersion: 1,
        id: 'parallel-test',
        deadlineSeconds,
        provenance: 'unit-test',
        tasks: [
            { id: 'a', taskClass: 'start', predecessorIds: [], successorIds: ['b', 'c'], workloadSize: 1, profiles: [testProfile('small', 10)] },
            { id: 'b', taskClass: 'branch', predecessorIds: ['a'], successorIds: ['d'], workloadSize: 1, profiles: [testProfile('small', 20)] },
            { id: 'c', taskClass: 'branch', predecessorIds: ['a'], successorIds: ['d'], workloadSize: 1, profiles: [testProfile('small', 30)] },
            { id: 'd', taskClass: 'join', predecessorIds: ['b', 'c'], successorIds: [], workloadSize: 1, profiles: [testProfile('small', 5)] },
        ],
    };
}

function selectedProfiles(workflow: DagWorkflow): Record<string, TaskPerformanceProfile> {
    return Object.fromEntries(workflow.tasks.map(task => [task.id, task.profiles[0]]));
}

describe('DAG workflow simulator', () => {
    it('respects dependencies and uses parallel makespan rather than summed duration', () => {
        const workflow = parallelWorkflow(45);
        const result = simulateWorkflow(workflow, selectedProfiles(workflow), TEST_MODES, TEST_PRICING);
        const assignments = Object.fromEntries(result.taskAssignments.map(item => [item.taskId, item]));

        expect(result.simulatedMakespanSeconds).toBe(45);
        expect(result.simulatedMakespanSeconds).toBeLessThan(10 + 20 + 30 + 5);
        expect(assignments['a'].startSeconds).toBe(0);
        expect(assignments['b'].startSeconds).toBe(10);
        expect(assignments['c'].startSeconds).toBe(10);
        expect(assignments['d'].startSeconds).toBe(40);
        expect(result.dependencyCriticalPathTaskIds).toEqual(['a', 'c', 'd']);
        expect(result.deadlineMet).toBe(true);
    });

    it('reports a missed deadline explicitly', () => {
        const workflow = parallelWorkflow(44.9);
        const result = simulateWorkflow(workflow, selectedProfiles(workflow), TEST_MODES, TEST_PRICING);
        expect(result.simulatedMakespanSeconds).toBe(45);
        expect(result.deadlineMet).toBe(false);
    });

    it('optionally enforces a concurrency quota', () => {
        const workflow = parallelWorkflow(100);
        const result = simulateWorkflow(
            workflow,
            selectedProfiles(workflow),
            TEST_MODES,
            TEST_PRICING,
            { maxConcurrentTasks: 1 },
        );
        expect(result.simulatedMakespanSeconds).toBe(65);
    });
});
