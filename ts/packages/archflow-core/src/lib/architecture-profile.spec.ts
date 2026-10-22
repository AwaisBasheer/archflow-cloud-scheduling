import {
    ArchitecturePerformanceConfig,
    assertComparableWorkflowInputs,
    buildJointArchitectureWorkflow,
    deriveArm64Workflow,
} from './architecture-profile';
import { DagWorkflow } from './model';
import { TEST_MODES, testProfile } from './test-fixtures';

const baseline: DagWorkflow = {
    schemaVersion: 1,
    id: 'architecture-profile-test',
    deadlineSeconds: 30,
    provenance: 'unit-test',
    tasks: [
        {
            id: 'task-a',
            taskClass: 'faster-on-arm',
            predecessorIds: [],
            successorIds: ['task-b'],
            workloadSize: 10,
            profiles: [testProfile('small', 10), testProfile('large', 4)],
        },
        {
            id: 'task-b',
            taskClass: 'slower-on-arm',
            predecessorIds: ['task-a'],
            successorIds: [],
            inputSizeBytes: 200,
            profiles: [testProfile('small', 5), testProfile('large', 2)],
        },
    ],
};

const config: ArchitecturePerformanceConfig = {
    schemaVersion: 1,
    randomSeed: 20261010,
    factorMeaning: 'ARM execution seconds divided by x86 execution seconds.',
    derivation: 'unit-test',
    profileSets: {
        mixed: {
            description: 'Unit-test assumptions.',
            baselineArchitecture: 'X86_64',
            targetArchitecture: 'ARM64',
            defaultExecutionTimeFactor: 1,
            taskClassExecutionTimeFactors: {
                'faster-on-arm': 0.8,
                'slower-on-arm': 1.2,
            },
            deterministicJitterFraction: 0.01,
        },
        neutral: {
            description: 'Equal performance.',
            baselineArchitecture: 'X86_64',
            targetArchitecture: 'ARM64',
            defaultExecutionTimeFactor: 1,
            taskClassExecutionTimeFactors: {},
            deterministicJitterFraction: 0,
        },
    },
};

describe('synthetic ARM64 performance profile derivation', () => {
    it('is deterministic, preserves workflow inputs, and records every factor', () => {
        const first = deriveArm64Workflow(baseline, TEST_MODES, config, 'mixed');
        const second = deriveArm64Workflow(baseline, TEST_MODES, config, 'mixed');

        expect(first).toEqual(second);
        expect(() => assertComparableWorkflowInputs(baseline, first)).not.toThrow();
        expect(first.tasks.flatMap(task => task.profiles).every(profile =>
            TEST_MODES[profile.resourceModeId].architecture === 'arm64')).toBe(true);
        expect(first.tasks.flatMap(task => task.profiles).every(profile =>
            profile.provenance.randomSeed === 20261010 &&
            profile.provenance.effectivePerformanceFactor !== undefined)).toBe(true);
        expect(first.tasks[0].profiles.every(profile =>
            (profile.provenance.effectivePerformanceFactor ?? 1) < 1)).toBe(true);
        expect(first.tasks[1].profiles.every(profile =>
            (profile.provenance.effectivePerformanceFactor ?? 1) > 1)).toBe(true);
    });

    it('makes neutral-control ARM execution times exactly equal to x86', () => {
        const neutral = deriveArm64Workflow(baseline, TEST_MODES, config, 'neutral');
        for (let taskIndex = 0; taskIndex < baseline.tasks.length; taskIndex += 1) {
            expect(neutral.tasks[taskIndex].profiles.map(profile => profile.executionSeconds))
                .toEqual(baseline.tasks[taskIndex].profiles.map(profile => profile.executionSeconds));
            expect(neutral.tasks[taskIndex].profiles.every(profile =>
                profile.provenance.effectivePerformanceFactor === 1)).toBe(true);
        }
    });

    it('builds joint candidates without changing DAG inputs or either architecture profile', () => {
        const joint = buildJointArchitectureWorkflow(baseline, TEST_MODES, config, 'mixed');

        expect(() => assertComparableWorkflowInputs(baseline, joint)).not.toThrow();
        expect(joint.tasks.every(task => task.profiles.length === 4)).toBe(true);
        expect(joint.tasks.every(task => new Set(task.profiles.map(profile =>
            TEST_MODES[profile.resourceModeId].architecture)).size === 2)).toBe(true);
    });
});
