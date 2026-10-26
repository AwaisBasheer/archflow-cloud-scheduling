import { calculateFargateTaskCost } from './fargate';
import { ArchFlowHScheduler } from './archflow-scheduler';
import { DagWorkflow, TaskPerformanceProfile } from './model';
import { simulateWorkflow } from './simulator';
import { TEST_MODES, TEST_PRICING, testProfile } from './test-fixtures';

function task(
    id: string,
    taskClass: string,
    predecessorIds: string[],
    successorIds: string[],
    profiles: TaskPerformanceProfile[],
) {
    return { id, taskClass, predecessorIds, successorIds, workloadSize: 1, profiles };
}

function sequentialMixed(deadlineSeconds: number): DagWorkflow {
    return {
        schemaVersion: 1,
        id: 'sequential-mixed',
        deadlineSeconds,
        provenance: 'hand-calculated unit test',
        tasks: [
            task('first', 'compute', [], ['second'], [
                testProfile('small', 15),
                testProfile('arm-small', 10),
            ]),
            task('second', 'compute', ['first'], [], [
                testProfile('small', 10),
                testProfile('arm-small', 40),
            ]),
        ],
    };
}

function assignmentModes(result: ReturnType<ArchFlowHScheduler['schedule']>): Record<string, string> {
    return Object.fromEntries(result.taskAssignments.map(item => [item.taskId, item.resourceMode.id]));
}

describe('ArchFlow-H joint architecture/resource scheduler', () => {
    it('makes task-instance architecture decisions for a tight sequential workflow', () => {
        const result = new ArchFlowHScheduler().schedule(sequentialMixed(25), TEST_MODES, TEST_PRICING);

        expect(result.deadlineMet).toBe(true);
        expect(result.simulatedMakespanSeconds).toBe(20);
        expect(assignmentModes(result)).toEqual({ first: 'arm-small', second: 'small' });
        expect(result.architectureDistribution).toEqual({ x86_64: 1, arm64: 1 });
        expect(result.taskAssignments[0].taskClass).toBe(result.taskAssignments[1].taskClass);
    });

    it('keeps the cheapest ARM modes under a loose deadline', () => {
        const result = new ArchFlowHScheduler().schedule(sequentialMixed(60), TEST_MODES, TEST_PRICING);

        expect(result.deadlineMet).toBe(true);
        expect(result.simulatedMakespanSeconds).toBe(50);
        expect(assignmentModes(result)).toEqual({ first: 'arm-small', second: 'arm-small' });
    });

    it('uses the identical heuristic with architecture selection fixed to x86 or ARM64', () => {
        const scheduler = new ArchFlowHScheduler();
        const x86 = scheduler.schedule(
            sequentialMixed(60),
            TEST_MODES,
            TEST_PRICING,
            {},
            { allowArchitectureSelection: false, fixedArchitecture: 'X86_64' },
        );
        const arm64 = scheduler.schedule(
            sequentialMixed(60),
            TEST_MODES,
            TEST_PRICING,
            {},
            { allowArchitectureSelection: false, fixedArchitecture: 'ARM64' },
        );

        expect(x86.schedulerId).toBe(arm64.schedulerId);
        expect(x86.allowArchitectureSelection).toBe(false);
        expect(arm64.allowArchitectureSelection).toBe(false);
        expect(x86.taskAssignments.every(item => item.resourceMode.architecture === 'x86_64')).toBe(true);
        expect(arm64.taskAssignments.every(item => item.resourceMode.architecture === 'arm64')).toBe(true);
    });

    it('rejects inconsistent architecture-ablation options', () => {
        const scheduler = new ArchFlowHScheduler();
        expect(() => scheduler.schedule(
            sequentialMixed(60), TEST_MODES, TEST_PRICING, {},
            { allowArchitectureSelection: false, fixedArchitecture: null },
        )).toThrow('fixedArchitecture is required');
        expect(() => scheduler.schedule(
            sequentialMixed(60), TEST_MODES, TEST_PRICING, {},
            { allowArchitectureSelection: true, fixedArchitecture: 'ARM64' },
        )).toThrow('fixedArchitecture must be null');
    });

    it('handles a fork/join whose critical branch changes after a latent upgrade', () => {
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'critical-path-switch',
            deadlineSeconds: 70,
            provenance: 'hand-calculated unit test',
            tasks: [
                task('root', 'control', [], ['a', 'b'], [testProfile('arm-small', 0)]),
                task('a', 'repeated', ['root'], ['join'], [
                    testProfile('arm-small', 100),
                    testProfile('medium', 50),
                ]),
                task('b', 'repeated', ['root'], ['join'], [
                    testProfile('arm-small', 100),
                    testProfile('medium', 60),
                ]),
                task('join', 'control', ['a', 'b'], [], [testProfile('arm-small', 0)]),
            ],
        };
        const result = new ArchFlowHScheduler().schedule(workflow, TEST_MODES, TEST_PRICING);

        expect(result.deadlineMet).toBe(true);
        expect(result.simulatedMakespanSeconds).toBe(60);
        expect(assignmentModes(result)).toMatchObject({ a: 'medium', b: 'medium' });
        expect(result.decisionTrace[0]).toMatchObject({
            taskId: 'a',
            makespanBeforeSeconds: 100,
            makespanAfterSeconds: 100,
        });
        expect(result.decisionTrace[1].criticalPathBefore).toContain('b');
    });

    it('preserves the fastest schedule and reports the deadline violation when infeasible', () => {
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'infeasible',
            deadlineSeconds: 80,
            provenance: 'hand-calculated unit test',
            tasks: [task('only', 'compute', [], [], [
                testProfile('arm-small', 100),
                testProfile('large', 90),
            ])],
        };
        const result = new ArchFlowHScheduler().schedule(workflow, TEST_MODES, TEST_PRICING);

        expect(result.feasible).toBe(false);
        expect(result.deadlineMet).toBe(false);
        expect(result.simulatedMakespanSeconds).toBe(90);
        expect(result.infeasibilityReason).toContain('10.000000000 seconds');
    });

    it('does not return a costlier latent branch change when infeasibility remains unchanged', () => {
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'infeasible-tied-branches',
            deadlineSeconds: 80,
            provenance: 'hand-calculated unit test',
            tasks: [
                task('a', 'branch', [], [], [
                    testProfile('arm-small', 100),
                    testProfile('medium', 50),
                ]),
                task('b', 'branch', [], [], [testProfile('arm-small', 100)]),
            ],
        };
        const result = new ArchFlowHScheduler().schedule(workflow, TEST_MODES, TEST_PRICING);

        expect(result.deadlineMet).toBe(false);
        expect(result.simulatedMakespanSeconds).toBe(100);
        expect(assignmentModes(result)).toEqual({ a: 'arm-small', b: 'arm-small' });
    });

    it('uses the common minimum-duration and rounding billing implementation', () => {
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'billing-rounding',
            deadlineSeconds: 70,
            provenance: 'hand-calculated unit test',
            tasks: [task('only', 'compute', [], [], [
                testProfile('small', 60.2, 1),
                testProfile('arm-small', 100, 0),
            ])],
        };
        const result = new ArchFlowHScheduler().schedule(workflow, TEST_MODES, TEST_PRICING);
        const assignment = result.taskAssignments[0];

        expect(assignment.resourceMode.id).toBe('small');
        expect(assignment.billableSeconds).toBe(62);
        expect(assignment.estimatedCostUsd).toBeCloseTo(
            calculateFargateTaskCost(TEST_MODES['small'], 60.2, 1, TEST_PRICING).totalCostUsd,
            15,
        );
    });

    it('honors a configured concurrency limit in the common simulator', () => {
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'quota',
            deadlineSeconds: 25,
            provenance: 'hand-calculated unit test',
            tasks: [
                task('a', 'parallel', [], [], [testProfile('arm-small', 10)]),
                task('b', 'parallel', [], [], [testProfile('arm-small', 10)]),
            ],
        };
        const result = new ArchFlowHScheduler().schedule(
            workflow,
            TEST_MODES,
            TEST_PRICING,
            { maxConcurrentTasks: 1 },
        );

        expect(result.deadlineMet).toBe(true);
        expect(result.simulatedMakespanSeconds).toBe(20);
        expect(result.taskAssignments.map(item => item.startSeconds)).toEqual([0, 10]);
    });

    it('breaks identical candidate ties deterministically by resource-mode ID', () => {
        const modes = {
            ...TEST_MODES,
            'arm-alias': { ...TEST_MODES['arm-small'], id: 'arm-alias' },
        };
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'tie',
            deadlineSeconds: 20,
            provenance: 'hand-calculated unit test',
            tasks: [task('only', 'neutral', [], [], [
                testProfile('arm-small', 10),
                testProfile('arm-alias', 10),
                testProfile('small', 10),
            ])],
        };
        const scheduler = new ArchFlowHScheduler();
        const first = scheduler.schedule(workflow, modes, TEST_PRICING);
        const second = scheduler.schedule(workflow, modes, TEST_PRICING);

        expect(first.taskAssignments[0].resourceMode.id).toBe('arm-alias');
        expect(assignmentModes(first)).toEqual(assignmentModes(second));
        expect(first.simulatedMakespanSeconds).toBe(second.simulatedMakespanSeconds);
        expect(first.estimatedExecutionCostUsd).toBe(second.estimatedExecutionCostUsd);
    });

    it('removes unsupported profiles when a valid candidate remains', () => {
        const workflow: DagWorkflow = {
            schemaVersion: 1,
            id: 'unsupported-candidate',
            deadlineSeconds: 20,
            provenance: 'hand-calculated unit test',
            tasks: [task('only', 'compute', [], [], [
                testProfile('not-in-catalog', 1),
                testProfile('arm-small', 10),
            ])],
        };
        const result = new ArchFlowHScheduler().schedule(workflow, TEST_MODES, TEST_PRICING);
        expect(result.taskAssignments[0].resourceMode.id).toBe('arm-small');
    });

    it('rejects negative durations and negative architecture prices', () => {
        const negativeDuration = sequentialMixed(25);
        negativeDuration.tasks[0].profiles[0].executionSeconds = -1;
        expect(() => new ArchFlowHScheduler().schedule(negativeDuration, TEST_MODES, TEST_PRICING))
            .toThrow('negative duration');

        const negativePricing = {
            ...TEST_PRICING,
            rates: {
                ...TEST_PRICING.rates,
                arm64: { ...TEST_PRICING.rates.arm64, vCpuPerSecondUsd: -1 },
            },
        };
        expect(() => new ArchFlowHScheduler().schedule(sequentialMixed(25), TEST_MODES, negativePricing))
            .toThrow('Missing or invalid arm64 pricing rates');
    });

    it('matches exhaustive optimal feasible cost on a tiny DAG without claiming general optimality', () => {
        const workflow = sequentialMixed(25);
        const taskProfiles = workflow.tasks.map(item => item.profiles);
        const feasible = [];
        for (const first of taskProfiles[0]) {
            for (const second of taskProfiles[1]) {
                const simulation = simulateWorkflow(
                    workflow,
                    { first, second },
                    TEST_MODES,
                    TEST_PRICING,
                );
                if (simulation.deadlineMet) {
                    feasible.push(simulation);
                }
            }
        }
        const optimum = feasible.sort((a, b) =>
            a.estimatedExecutionCostUsd - b.estimatedExecutionCostUsd ||
            a.simulatedMakespanSeconds - b.simulatedMakespanSeconds,
        )[0];
        const heuristic = new ArchFlowHScheduler().schedule(workflow, TEST_MODES, TEST_PRICING);

        expect(feasible).toHaveLength(2);
        expect(heuristic.estimatedExecutionCostUsd).toBeCloseTo(optimum.estimatedExecutionCostUsd, 15);
        expect(heuristic.simulatedMakespanSeconds).toBe(optimum.simulatedMakespanSeconds);
    });
});
