import { DagWorkflow } from './model';
import {
    FixedArchitectureProportionalDeadlineScheduler,
    FixedX86ProportionalDeadlineScheduler,
} from './x86-scheduler';
import { TEST_MODES, TEST_PRICING, testProfile } from './test-fixtures';

function workflow(deadlineSeconds: number): DagWorkflow {
    return {
        schemaVersion: 1,
        id: 'scheduler-test',
        deadlineSeconds,
        provenance: 'unit-test',
        tasks: [
            {
                id: 'setup',
                taskClass: 'setup',
                predecessorIds: [],
                successorIds: ['compute'],
                workloadSize: 1,
                profiles: [
                    testProfile('small', 1),
                    testProfile('medium', 1),
                    testProfile('large', 1),
                    testProfile('xlarge', 1),
                    testProfile('xxlarge', 1),
                    testProfile('arm-small', 1),
                    testProfile('arm-medium', 1),
                    testProfile('arm-large', 1),
                    testProfile('arm-xlarge', 1),
                    testProfile('arm-xxlarge', 1),
                ],
            },
            {
                id: 'compute',
                taskClass: 'compute',
                predecessorIds: ['setup'],
                successorIds: [],
                workloadSize: 100,
                profiles: [
                    testProfile('small', 100),
                    testProfile('medium', 45),
                    testProfile('large', 20),
                    testProfile('xlarge', 12),
                    testProfile('xxlarge', 8),
                    testProfile('arm-small', 110),
                    testProfile('arm-medium', 50),
                    testProfile('arm-large', 22),
                    testProfile('arm-xlarge', 13),
                    testProfile('arm-xxlarge', 9),
                ],
            },
        ],
    };
}

describe('fixed x86 proportional critical-path scheduler', () => {
    it('selects only x86 modes and can choose different sizes per task', () => {
        const scheduler = new FixedX86ProportionalDeadlineScheduler();
        const result = scheduler.schedule(workflow(25), TEST_MODES, TEST_PRICING);
        const modes = Object.fromEntries(result.taskAssignments.map(item => [item.taskId, item.resourceMode.id]));

        expect(result.feasible).toBe(true);
        expect(result.deadlineMet).toBe(true);
        expect(result.simulatedMakespanSeconds).toBeLessThanOrEqual(25);
        expect(result.taskAssignments.every(item => item.resourceMode.architecture === 'x86_64')).toBe(true);
        expect(modes['setup']).toBe('small');
        expect(modes['compute']).not.toBe('small');
        expect(new Set(Object.values(modes)).size).toBeGreaterThan(1);
    });

    it('is deterministic for assignments and simulated metrics', () => {
        const scheduler = new FixedX86ProportionalDeadlineScheduler();
        const first = scheduler.schedule(workflow(25), TEST_MODES, TEST_PRICING);
        const second = scheduler.schedule(workflow(25), TEST_MODES, TEST_PRICING);

        expect(first.taskAssignments.map(item => item.resourceMode.id))
            .toEqual(second.taskAssignments.map(item => item.resourceMode.id));
        expect(first.simulatedMakespanSeconds).toBe(second.simulatedMakespanSeconds);
        expect(first.estimatedExecutionCostUsd).toBe(second.estimatedExecutionCostUsd);
    });

    it('reports infeasibility when the fastest x86 schedule misses the deadline', () => {
        const scheduler = new FixedX86ProportionalDeadlineScheduler();
        const result = scheduler.schedule(workflow(5), TEST_MODES, TEST_PRICING);
        expect(result.feasible).toBe(false);
        expect(result.deadlineMet).toBe(false);
        expect(result.infeasibilityReason).toContain('No faster x86_64');
    });

    it('uses the same scheduler implementation while enforcing an ARM64 restriction', () => {
        const scheduler = new FixedArchitectureProportionalDeadlineScheduler('ARM64');
        const result = scheduler.schedule(workflow(28), TEST_MODES, TEST_PRICING);

        expect(result.schedulerId).toBe('fixed-arm64-proportional-critical-path-v1');
        expect(result.deadlineMet).toBe(true);
        expect(result.taskAssignments.every(item => item.resourceMode.architecture === 'arm64')).toBe(true);
    });
});
