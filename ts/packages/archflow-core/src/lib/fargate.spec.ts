import {
    buildResourceModeMap,
    calculateFargateTaskCost,
    isValidLinuxFargateCombination,
} from './fargate';
import { ResourceModeCatalog } from './model';
import { TEST_MODES, TEST_PRICING } from './test-fixtures';

describe('Fargate resource and pricing model', () => {
    it.each([
        [0.25, 0.5],
        [0.5, 1],
        [1, 2],
        [2, 4],
        [4, 8],
        [8, 60],
        [16, 120],
        [32, 244],
    ])('accepts valid Linux combination %s vCPU/%s GB', (vCpu, memoryGb) => {
        expect(isValidLinuxFargateCombination(vCpu, memoryGb)).toBe(true);
    });

    it.each([
        [0.25, 0.25],
        [0.5, 0.5],
        [1, 1],
        [2, 3],
        [4, 31],
        [8, 18],
        [3, 8],
    ])('rejects invalid Linux combination %s vCPU/%s GB', (vCpu, memoryGb) => {
        expect(isValidLinuxFargateCombination(vCpu, memoryGb)).toBe(false);
    });

    it('rejects an invalid mode while building a catalog', () => {
        const catalog: ResourceModeCatalog = {
            schemaVersion: 1,
            source: 'test',
            retrievedAt: '2026-10-10',
            modes: [{ id: 'invalid', architecture: 'x86_64', vCpu: 1, memoryGb: 1 }],
        };
        expect(() => buildResourceModeMap(catalog)).toThrow('Invalid Linux Fargate CPU/memory combination');
    });

    it('applies the 60-second Linux minimum to a short task', () => {
        const cost = calculateFargateTaskCost(TEST_MODES['large'], 10, 0, TEST_PRICING);
        expect(cost.actualDurationSeconds).toBe(10);
        expect(cost.billableSeconds).toBe(60);
        expect(cost.vCpuCostUsd).toBeCloseTo(0.00067464, 12);
        expect(cost.memoryCostUsd).toBeCloseTo(0.0001482, 12);
        expect(cost.totalCostUsd).toBeCloseTo(0.00082284, 12);
    });

    it('includes startup overhead and rounds a longer task up to a second', () => {
        const cost = calculateFargateTaskCost(TEST_MODES['large'], 60.2, 1, TEST_PRICING);
        expect(cost.actualDurationSeconds).toBeCloseTo(61.2);
        expect(cost.billableSeconds).toBe(62);
        expect(cost.totalCostUsd).toBeCloseTo(0.000850268, 12);
    });
});
