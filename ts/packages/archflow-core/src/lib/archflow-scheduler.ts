import { performance } from 'node:perf_hooks';
import { longestPathDurationsFromTasks, taskMapFor, topologicalOrder, validateWorkflow } from './dag';
import { calculateFargateTaskCost, validateResourceMode } from './fargate';
import {
    ArchFlowDecisionRecord,
    ArchFlowScheduleResult,
    ArchFlowSchedulerOptions,
    CpuArchitecture,
    DagWorkflow,
    FargatePricingConfig,
    ResourceMode,
    TaskPerformanceProfile,
    TaskSchedulingAnalysis,
    WorkflowSimulationResult,
} from './model';
import { SimulationOptions, simulateWorkflow } from './simulator';
import { cpuArchitectureFor } from './x86-scheduler';

export const ARCHFLOW_H_SCHEDULER_ID = 'archflow-h-joint-deadline-cost-v1';
const EPSILON = 1e-12;

interface CandidateEvaluation {
    taskId: string;
    profile: TaskPerformanceProfile;
    simulation: WorkflowSimulationResult;
    makespanReductionSeconds: number;
    localDurationReductionSeconds: number;
    costDeltaUsd: number;
    onCriticalPath: boolean;
}

export class ArchFlowHScheduler {
    schedule(
        workflow: DagWorkflow,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
        simulationOptions: SimulationOptions = {},
        schedulerOptions: ArchFlowSchedulerOptions = {
            allowArchitectureSelection: true,
            fixedArchitecture: null,
        },
    ): ArchFlowScheduleResult {
        const schedulingStart = performance.now();
        validateWorkflow(workflow);
        const tasks = taskMapFor(workflow);
        const order = topologicalOrder(workflow);
        const candidatesByTask: Record<string, TaskPerformanceProfile[]> = {};
        if (schedulerOptions.allowArchitectureSelection && schedulerOptions.fixedArchitecture !== null) {
            throw new Error('fixedArchitecture must be null when architecture selection is enabled.');
        }
        if (!schedulerOptions.allowArchitectureSelection && schedulerOptions.fixedArchitecture === null) {
            throw new Error('fixedArchitecture is required when architecture selection is disabled.');
        }
        const fixedCpuArchitecture = schedulerOptions.fixedArchitecture === null
            ? undefined
            : cpuArchitectureFor(schedulerOptions.fixedArchitecture);

        for (const taskId of order) {
            candidatesByTask[taskId] = tasks[taskId].profiles
                .filter(profile => {
                    const mode = resourceModes[profile.resourceModeId];
                    if (!mode) {
                        return false;
                    }
                    if (fixedCpuArchitecture && mode.architecture !== fixedCpuArchitecture) {
                        return false;
                    }
                    validateResourceMode(mode);
                    calculateFargateTaskCost(
                        mode,
                        profile.executionSeconds,
                        profile.startupOverheadSeconds,
                        pricing,
                    );
                    return true;
                })
                .sort((a, b) => this.compareByCostThenDuration(a, b, resourceModes, pricing));
            if (candidatesByTask[taskId].length === 0) {
                throw new Error(`Task ${taskId} has no supported Fargate performance profile.`);
            }
        }

        const staticAnalysis = this.analyzeFastestPaths(workflow, candidatesByTask);
        const selectedProfiles = Object.fromEntries(order.map(taskId => [taskId, candidatesByTask[taskId][0]]));
        let simulation = simulateWorkflow(workflow, selectedProfiles, resourceModes, pricing, simulationOptions);
        let bestInfeasibleSimulation = simulation;
        let bestInfeasibleProfiles = { ...selectedProfiles };
        let selectionIterations = 1;
        const decisionTrace: ArchFlowDecisionRecord[] = [];
        const maximumAcceptedChanges = Object.values(candidatesByTask)
            .reduce((sum, candidates) => sum + candidates.length, 0);

        while (!simulation.deadlineMet && selectionIterations <= maximumAcceptedChanges) {
            const improvement = this.findDeadlineImprovement(
                workflow,
                simulation,
                selectedProfiles,
                candidatesByTask,
                resourceModes,
                pricing,
                simulationOptions,
            );
            if (!improvement) {
                break;
            }
            const previous = simulation;
            const fromProfile = selectedProfiles[improvement.taskId];
            selectedProfiles[improvement.taskId] = improvement.profile;
            simulation = improvement.simulation;
            decisionTrace.push(this.decisionRecord(
                'deadline-improvement',
                improvement.taskId,
                fromProfile,
                improvement.profile,
                previous,
                simulation,
            ));
            selectionIterations += 1;
            if (!simulation.deadlineMet && (
                simulation.simulatedMakespanSeconds < bestInfeasibleSimulation.simulatedMakespanSeconds - EPSILON ||
                Math.abs(simulation.simulatedMakespanSeconds - bestInfeasibleSimulation.simulatedMakespanSeconds) <= EPSILON &&
                    simulation.estimatedExecutionCostUsd < bestInfeasibleSimulation.estimatedExecutionCostUsd - EPSILON
            )) {
                bestInfeasibleSimulation = simulation;
                bestInfeasibleProfiles = { ...selectedProfiles };
            }
        }

        if (!simulation.deadlineMet) {
            simulation = bestInfeasibleSimulation;
            for (const taskId of order) {
                selectedProfiles[taskId] = bestInfeasibleProfiles[taskId];
            }
        }

        while (simulation.deadlineMet && selectionIterations <= maximumAcceptedChanges * 2) {
            const refinement = this.findCostRefinement(
                workflow,
                simulation,
                selectedProfiles,
                candidatesByTask,
                resourceModes,
                pricing,
                simulationOptions,
            );
            if (!refinement) {
                break;
            }
            const previous = simulation;
            const fromProfile = selectedProfiles[refinement.taskId];
            selectedProfiles[refinement.taskId] = refinement.profile;
            simulation = refinement.simulation;
            decisionTrace.push(this.decisionRecord(
                'cost-refinement',
                refinement.taskId,
                fromProfile,
                refinement.profile,
                previous,
                simulation,
            ));
            selectionIterations += 1;
        }

        const architectureDistribution: Record<CpuArchitecture, number> = { x86_64: 0, arm64: 0 };
        for (const assignment of simulation.taskAssignments) {
            architectureDistribution[assignment.resourceMode.architecture] += 1;
        }

        return {
            schemaVersion: 1,
            schedulerId: ARCHFLOW_H_SCHEDULER_ID,
            ...simulation,
            feasible: simulation.deadlineMet,
            ...(simulation.deadlineMet ? {} : {
                infeasibilityReason: `No available joint architecture/resource change can satisfy the deadline; ` +
                    `violation is ${(simulation.simulatedMakespanSeconds - workflow.deadlineSeconds).toFixed(9)} seconds.`,
            }),
            schedulingDecisionOverheadMs: performance.now() - schedulingStart,
            selectionIterations,
            allowArchitectureSelection: schedulerOptions.allowArchitectureSelection,
            fixedArchitecture: schedulerOptions.fixedArchitecture,
            architectureDistribution,
            taskSchedulingAnalysis: this.finalTaskAnalysis(workflow, simulation, staticAnalysis),
            decisionTrace,
        };
    }

    private findDeadlineImprovement(
        workflow: DagWorkflow,
        current: WorkflowSimulationResult,
        selectedProfiles: Record<string, TaskPerformanceProfile>,
        candidatesByTask: Record<string, TaskPerformanceProfile[]>,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
        simulationOptions: SimulationOptions,
    ): CandidateEvaluation | undefined {
        const critical = new Set(current.dependencyCriticalPathTaskIds);
        const evaluations: CandidateEvaluation[] = [];
        for (const taskId of topologicalOrder(workflow)) {
            const currentProfile = selectedProfiles[taskId];
            const currentDuration = this.duration(currentProfile);
            for (const profile of candidatesByTask[taskId]) {
                const localReduction = currentDuration - this.duration(profile);
                if (localReduction <= EPSILON) {
                    continue;
                }
                const candidateSimulation = simulateWorkflow(
                    workflow,
                    { ...selectedProfiles, [taskId]: profile },
                    resourceModes,
                    pricing,
                    simulationOptions,
                );
                const makespanReduction = current.simulatedMakespanSeconds - candidateSimulation.simulatedMakespanSeconds;
                const onCriticalPath = critical.has(taskId);
                if (makespanReduction < -EPSILON || makespanReduction <= EPSILON && !onCriticalPath) {
                    continue;
                }
                evaluations.push({
                    taskId,
                    profile,
                    simulation: candidateSimulation,
                    makespanReductionSeconds: Math.max(0, makespanReduction),
                    localDurationReductionSeconds: localReduction,
                    costDeltaUsd: candidateSimulation.estimatedExecutionCostUsd - current.estimatedExecutionCostUsd,
                    onCriticalPath,
                });
            }
        }
        evaluations.sort((a, b) => this.compareDeadlineImprovements(a, b));
        return evaluations[0];
    }

    private compareDeadlineImprovements(a: CandidateEvaluation, b: CandidateEvaluation): number {
        const aActual = a.makespanReductionSeconds > EPSILON ? 1 : 0;
        const bActual = b.makespanReductionSeconds > EPSILON ? 1 : 0;
        if (aActual !== bActual) {
            return bActual - aActual;
        }
        const aFree = a.costDeltaUsd <= EPSILON ? 1 : 0;
        const bFree = b.costDeltaUsd <= EPSILON ? 1 : 0;
        if (aFree !== bFree) {
            return bFree - aFree;
        }
        const aBenefit = aActual ? a.makespanReductionSeconds : a.localDurationReductionSeconds;
        const bBenefit = bActual ? b.makespanReductionSeconds : b.localDurationReductionSeconds;
        const aEfficiency = a.costDeltaUsd <= EPSILON ? Number.POSITIVE_INFINITY : aBenefit / a.costDeltaUsd;
        const bEfficiency = b.costDeltaUsd <= EPSILON ? Number.POSITIVE_INFINITY : bBenefit / b.costDeltaUsd;
        return bEfficiency - aEfficiency ||
            bBenefit - aBenefit ||
            a.simulation.estimatedExecutionCostUsd - b.simulation.estimatedExecutionCostUsd ||
            a.simulation.simulatedMakespanSeconds - b.simulation.simulatedMakespanSeconds ||
            a.taskId.localeCompare(b.taskId) ||
            a.profile.resourceModeId.localeCompare(b.profile.resourceModeId);
    }

    private findCostRefinement(
        workflow: DagWorkflow,
        current: WorkflowSimulationResult,
        selectedProfiles: Record<string, TaskPerformanceProfile>,
        candidatesByTask: Record<string, TaskPerformanceProfile[]>,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
        simulationOptions: SimulationOptions,
    ): CandidateEvaluation | undefined {
        const evaluations: CandidateEvaluation[] = [];
        for (const taskId of topologicalOrder(workflow)) {
            const currentProfile = selectedProfiles[taskId];
            for (const profile of candidatesByTask[taskId]) {
                if (profile.resourceModeId === currentProfile.resourceModeId) {
                    continue;
                }
                const candidateSimulation = simulateWorkflow(
                    workflow,
                    { ...selectedProfiles, [taskId]: profile },
                    resourceModes,
                    pricing,
                    simulationOptions,
                );
                const costDelta = candidateSimulation.estimatedExecutionCostUsd - current.estimatedExecutionCostUsd;
                if (!candidateSimulation.deadlineMet || costDelta >= -EPSILON) {
                    continue;
                }
                evaluations.push({
                    taskId,
                    profile,
                    simulation: candidateSimulation,
                    makespanReductionSeconds: current.simulatedMakespanSeconds - candidateSimulation.simulatedMakespanSeconds,
                    localDurationReductionSeconds: this.duration(currentProfile) - this.duration(profile),
                    costDeltaUsd: costDelta,
                    onCriticalPath: current.dependencyCriticalPathTaskIds.includes(taskId),
                });
            }
        }
        evaluations.sort((a, b) =>
            a.costDeltaUsd - b.costDeltaUsd ||
            a.simulation.simulatedMakespanSeconds - b.simulation.simulatedMakespanSeconds ||
            a.taskId.localeCompare(b.taskId) ||
            a.profile.resourceModeId.localeCompare(b.profile.resourceModeId),
        );
        return evaluations[0];
    }

    private analyzeFastestPaths(
        workflow: DagWorkflow,
        candidatesByTask: Record<string, TaskPerformanceProfile[]>,
    ): Record<string, Omit<TaskSchedulingAnalysis, 'selectedSlackSeconds' | 'finalCriticalPath'>> {
        const tasks = taskMapFor(workflow);
        const order = topologicalOrder(workflow);
        const fastestDuration = Object.fromEntries(order.map(taskId => [
            taskId,
            Math.min(...candidatesByTask[taskId].map(profile => this.duration(profile))),
        ]));
        const fastestDownstream = longestPathDurationsFromTasks(workflow, fastestDuration);
        const earliestStart: Record<string, number> = {};
        const earliestFinish: Record<string, number> = {};
        for (const taskId of order) {
            earliestStart[taskId] = tasks[taskId].predecessorIds.length === 0
                ? 0
                : Math.max(...tasks[taskId].predecessorIds.map(id => earliestFinish[id]));
            earliestFinish[taskId] = earliestStart[taskId] + fastestDuration[taskId];
        }
        return Object.fromEntries(order.map(taskId => [taskId, {
            taskId,
            earliestPossibleStartSeconds: earliestStart[taskId],
            earliestPossibleFinishSeconds: earliestFinish[taskId],
            fastestDownstreamPathSeconds: fastestDownstream[taskId],
            staticSlackSeconds: workflow.deadlineSeconds - earliestStart[taskId] - fastestDownstream[taskId],
        }]));
    }

    private finalTaskAnalysis(
        workflow: DagWorkflow,
        simulation: WorkflowSimulationResult,
        staticAnalysis: Record<string, Omit<TaskSchedulingAnalysis, 'selectedSlackSeconds' | 'finalCriticalPath'>>,
    ): TaskSchedulingAnalysis[] {
        const durationByTask = Object.fromEntries(simulation.taskAssignments.map(item => [
            item.taskId,
            item.simulatedDurationSeconds,
        ]));
        const selectedDownstream = longestPathDurationsFromTasks(workflow, durationByTask);
        const assignmentByTask = Object.fromEntries(simulation.taskAssignments.map(item => [item.taskId, item]));
        const critical = new Set(simulation.dependencyCriticalPathTaskIds);
        return topologicalOrder(workflow).map(taskId => ({
            ...staticAnalysis[taskId],
            selectedSlackSeconds: workflow.deadlineSeconds -
                assignmentByTask[taskId].startSeconds - selectedDownstream[taskId],
            finalCriticalPath: critical.has(taskId),
        }));
    }

    private decisionRecord(
        phase: ArchFlowDecisionRecord['phase'],
        taskId: string,
        from: TaskPerformanceProfile,
        to: TaskPerformanceProfile,
        before: WorkflowSimulationResult,
        after: WorkflowSimulationResult,
    ): ArchFlowDecisionRecord {
        return {
            phase,
            taskId,
            fromResourceModeId: from.resourceModeId,
            toResourceModeId: to.resourceModeId,
            criticalPathBefore: [...before.dependencyCriticalPathTaskIds],
            makespanBeforeSeconds: before.simulatedMakespanSeconds,
            makespanAfterSeconds: after.simulatedMakespanSeconds,
            costBeforeUsd: before.estimatedExecutionCostUsd,
            costAfterUsd: after.estimatedExecutionCostUsd,
        };
    }

    private compareByCostThenDuration(
        a: TaskPerformanceProfile,
        b: TaskPerformanceProfile,
        resourceModes: Record<string, ResourceMode>,
        pricing: FargatePricingConfig,
    ): number {
        const cost = (profile: TaskPerformanceProfile): number => calculateFargateTaskCost(
            resourceModes[profile.resourceModeId],
            profile.executionSeconds,
            profile.startupOverheadSeconds,
            pricing,
        ).totalCostUsd;
        return cost(a) - cost(b) ||
            this.duration(a) - this.duration(b) ||
            a.resourceModeId.localeCompare(b.resourceModeId);
    }

    private duration(profile: TaskPerformanceProfile): number {
        return profile.executionSeconds + profile.startupOverheadSeconds;
    }
}
