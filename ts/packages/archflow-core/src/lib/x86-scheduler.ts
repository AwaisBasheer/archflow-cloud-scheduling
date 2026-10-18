import { performance } from 'node:perf_hooks';
import { longestPathDurationsFromTasks, taskMapFor, topologicalOrder, validateWorkflow } from './dag';
import { calculateFargateTaskCost } from './fargate';
import {
    ArchitectureRestriction,
    CpuArchitecture,
    DagWorkflow,
    FargatePricingConfig,
    ResourceMode,
    ScheduleResult,
    TaskPerformanceProfile,
    WorkflowSimulationResult,
} from './model';
import { SimulationOptions, simulateWorkflow } from './simulator';

export const FIXED_X86_SCHEDULER_ID = 'fixed-x86-proportional-critical-path-v1';
export const FIXED_ARM64_SCHEDULER_ID = 'fixed-arm64-proportional-critical-path-v1';

export function cpuArchitectureFor(restriction: ArchitectureRestriction): CpuArchitecture {
    return restriction === 'X86_64' ? 'x86_64' : 'arm64';
}

interface UpgradeCandidate {
    taskId: string;
    profile: TaskPerformanceProfile;
    simulation: WorkflowSimulationResult;
    costPerSecondReduced: number;
}

export class FixedArchitectureProportionalDeadlineScheduler {
    readonly targetArchitecture: CpuArchitecture;

    constructor(readonly architecture: ArchitectureRestriction) {
        this.targetArchitecture = cpuArchitectureFor(architecture);
    }

    schedule(
        workflow: DagWorkflow,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
        simulationOptions: SimulationOptions = {},
    ): ScheduleResult {
        const start = performance.now();
        validateWorkflow(workflow);
        const tasks = taskMapFor(workflow);
        const order = topologicalOrder(workflow);
        const candidatesByTask: Record<string, TaskPerformanceProfile[]> = {};

        for (const taskId of order) {
            const architectureProfiles = tasks[taskId].profiles
                .filter(profile => resourceModes[profile.resourceModeId]?.architecture === this.targetArchitecture)
                .sort((a, b) => this.compareProfilesByCost(a, b, resourceModes, pricing));
            if (architectureProfiles.length === 0) {
                throw new Error(`Task ${taskId} has no ${this.targetArchitecture} performance profile.`);
            }
            candidatesByTask[taskId] = architectureProfiles;
        }

        const averageDurationByTask: Record<string, number> = {};
        for (const taskId of order) {
            averageDurationByTask[taskId] = candidatesByTask[taskId]
                .reduce((sum, profile) => sum + this.profileDuration(profile), 0) / candidatesByTask[taskId].length;
        }
        const averageLongestPath = longestPathDurationsFromTasks(workflow, averageDurationByTask);

        const selectedProfiles: Record<string, TaskPerformanceProfile> = {};
        const selectedFinish: Record<string, number> = {};
        for (const taskId of order) {
            const task = tasks[taskId];
            const earliestStart = task.predecessorIds.length === 0
                ? 0
                : Math.max(...task.predecessorIds.map(predecessorId => selectedFinish[predecessorId]));
            const remainingDeadline = Math.max(0, workflow.deadlineSeconds - earliestStart);
            const localDurationBudget = averageLongestPath[taskId] === 0
                ? 0
                : remainingDeadline * averageDurationByTask[taskId] / averageLongestPath[taskId];
            selectedProfiles[taskId] = this.selectCheapestWithinBudget(
                candidatesByTask[taskId],
                localDurationBudget,
                resourceModes,
                pricing,
            );
            selectedFinish[taskId] = earliestStart + this.profileDuration(selectedProfiles[taskId]);
        }

        let simulation = simulateWorkflow(workflow, selectedProfiles, resourceModes, pricing, simulationOptions);
        let selectionIterations = 1;
        const maximumIterations = Object.values(candidatesByTask)
            .reduce((sum, profiles) => sum + profiles.length, 0);

        while (!simulation.deadlineMet && selectionIterations < maximumIterations) {
            const upgrade = this.findBestCriticalPathUpgrade(
                workflow,
                simulation,
                selectedProfiles,
                candidatesByTask,
                resourceModes,
                pricing,
                simulationOptions,
            );
            if (!upgrade) {
                break;
            }
            selectedProfiles[upgrade.taskId] = upgrade.profile;
            simulation = upgrade.simulation;
            selectionIterations += 1;
        }

        const schedulingDecisionOverheadMs = performance.now() - start;
        return {
            schemaVersion: 1,
            schedulerId: this.targetArchitecture === 'x86_64'
                ? FIXED_X86_SCHEDULER_ID
                : FIXED_ARM64_SCHEDULER_ID,
            ...simulation,
            feasible: simulation.deadlineMet,
            ...(simulation.deadlineMet ? {} : {
                infeasibilityReason: `No faster ${this.targetArchitecture} critical-path configuration can satisfy the workflow deadline.`,
            }),
            schedulingDecisionOverheadMs,
            selectionIterations,
        };
    }

    private selectCheapestWithinBudget(
        profiles: TaskPerformanceProfile[],
        durationBudgetSeconds: number,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
    ): TaskPerformanceProfile {
        const compliant = profiles.filter(profile => this.profileDuration(profile) <= durationBudgetSeconds);
        if (compliant.length > 0) {
            return [...compliant].sort((a, b) => this.compareProfilesByCost(a, b, resourceModes, pricing))[0];
        }
        return [...profiles].sort((a, b) =>
            this.profileDuration(a) - this.profileDuration(b) ||
            this.compareProfilesByCost(a, b, resourceModes, pricing),
        )[0];
    }

    private findBestCriticalPathUpgrade(
        workflow: DagWorkflow,
        currentSimulation: WorkflowSimulationResult,
        selectedProfiles: Record<string, TaskPerformanceProfile>,
        candidatesByTask: Record<string, TaskPerformanceProfile[]>,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
        simulationOptions: SimulationOptions,
    ): UpgradeCandidate | undefined {
        const upgrades: UpgradeCandidate[] = [];
        for (const taskId of currentSimulation.dependencyCriticalPathTaskIds) {
            const currentProfile = selectedProfiles[taskId];
            for (const profile of candidatesByTask[taskId]) {
                if (this.profileDuration(profile) >= this.profileDuration(currentProfile)) {
                    continue;
                }
                const candidateProfiles = { ...selectedProfiles, [taskId]: profile };
                const candidateSimulation = simulateWorkflow(
                    workflow,
                    candidateProfiles,
                    resourceModes,
                    pricing,
                    simulationOptions,
                );
                const reduction = currentSimulation.simulatedMakespanSeconds - candidateSimulation.simulatedMakespanSeconds;
                if (reduction <= 0) {
                    continue;
                }
                const costIncrease = candidateSimulation.estimatedExecutionCostUsd - currentSimulation.estimatedExecutionCostUsd;
                upgrades.push({
                    taskId,
                    profile,
                    simulation: candidateSimulation,
                    costPerSecondReduced: costIncrease / reduction,
                });
            }
        }
        upgrades.sort((a, b) =>
            a.costPerSecondReduced - b.costPerSecondReduced ||
            a.simulation.estimatedExecutionCostUsd - b.simulation.estimatedExecutionCostUsd ||
            a.simulation.simulatedMakespanSeconds - b.simulation.simulatedMakespanSeconds ||
            a.taskId.localeCompare(b.taskId) ||
            a.profile.resourceModeId.localeCompare(b.profile.resourceModeId),
        );
        return upgrades[0];
    }

    private compareProfilesByCost(
        a: TaskPerformanceProfile,
        b: TaskPerformanceProfile,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
    ): number {
        const aCost = calculateFargateTaskCost(
            resourceModes[a.resourceModeId],
            a.executionSeconds,
            a.startupOverheadSeconds,
            pricing,
        ).totalCostUsd;
        const bCost = calculateFargateTaskCost(
            resourceModes[b.resourceModeId],
            b.executionSeconds,
            b.startupOverheadSeconds,
            pricing,
        ).totalCostUsd;
        return aCost - bCost ||
            this.profileDuration(a) - this.profileDuration(b) ||
            a.resourceModeId.localeCompare(b.resourceModeId);
    }

    private profileDuration(profile: TaskPerformanceProfile): number {
        return profile.executionSeconds + profile.startupOverheadSeconds;
    }
}

/** Backwards-compatible Phase 3 entry point; the algorithm lives in the parameterized base class. */
export class FixedX86ProportionalDeadlineScheduler extends FixedArchitectureProportionalDeadlineScheduler {
    constructor() {
        super('X86_64');
    }
}
