import { adaptChunkFuncWorkflow, ChunkFuncExecutionDescription, ChunkFuncProxyMapping, ChunkFuncWorkflowDescription } from './chunkfunc-adapter';
import { TEST_MODES } from './test-fixtures';

describe('ChunkFunc performance-profile adapter', () => {
    it('converts milliseconds to seconds and keeps proxy provenance explicit', () => {
        const workflowDescription: ChunkFuncWorkflowDescription = {
            name: 'proxy-test',
            startStep: 'a',
            endStep: 'b',
            availableResourceProfiles: [{ memoryMiB: 512, milliCpu: 333 }],
            steps: [
                {
                    name: 'a',
                    type: 'function',
                    successors: ['b'],
                    profilingResults: { results: [{ resourceProfileId: '512mib-333m', results: [{ executionTimeMs: 1500, inputSizeBytes: 100, statusCode: 200 }] }] },
                },
                {
                    name: 'b',
                    type: 'function',
                    profilingResults: { results: [{ resourceProfileId: '512mib-333m', results: [{ executionTimeMs: 2500, inputSizeBytes: 50, statusCode: 200 }] }] },
                },
            ],
        };
        const executionDescription: ChunkFuncExecutionDescription = {
            scenarioName: 'test-scenario',
            inputSizeBytes: 100,
            maxResponseTimeMs: 10000,
            stepExecutions: {
                a: { outputSizeBytes: 50 },
                b: { outputSizeBytes: 10 },
            },
        };
        const mapping: ChunkFuncProxyMapping = {
            schemaVersion: 1,
            startupOverheadSeconds: 2,
            modeToChunkFuncProfile: { small: '512mib-333m' },
            taskClassAliases: { a: 'shared-class', b: 'shared-class' },
            provenance: 'Not a Fargate measurement.',
        };

        const adapted = adaptChunkFuncWorkflow(workflowDescription, executionDescription, TEST_MODES, mapping);
        expect(adapted.deadlineSeconds).toBe(10);
        expect(adapted.tasks[0].profiles[0].executionSeconds).toBe(1.5);
        expect(adapted.tasks[0].profiles[0].startupOverheadSeconds).toBe(2);
        expect(adapted.tasks[0].profiles[0].provenance.kind).toBe('chunkfunc-proxy');
        expect(adapted.tasks[0].profiles[0].provenance.notes).toContain('Not a Fargate measurement');
        expect(adapted.tasks[1].predecessorIds).toEqual(['a']);
        expect(adapted.tasks[1].inputSizeBytes).toBe(50);
        expect(adapted.tasks.map(task => task.taskClass)).toEqual(['shared-class', 'shared-class']);
    });
});
