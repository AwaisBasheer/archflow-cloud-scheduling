import { conservativeTaskUpperBoundUsd } from './cost';
import { AwsPriceRates, CostGuardrailConfig, FargateLaunchSpec } from './model';

export interface GuardrailSnapshot {
    submitted: number;
    running: number;
    succeeded: number;
    failed: number;
    consecutiveFailures: number;
    accruedEstimatedUsd: number;
    committedUpperBoundUsd: number;
    haltedReason?: string;
}

export class ExperimentCostGuardrail {
    private snapshot: GuardrailSnapshot = {
        submitted: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        consecutiveFailures: 0,
        accruedEstimatedUsd: 0,
        committedUpperBoundUsd: 0,
    };

    constructor(private readonly config: CostGuardrailConfig, private readonly prices: AwsPriceRates) {}

    current(): GuardrailSnapshot {
        return { ...this.snapshot };
    }

    admit(spec: FargateLaunchSpec): number {
        if (this.snapshot.haltedReason) {
            throw new Error(`Experiment is halted: ${this.snapshot.haltedReason}`);
        }
        if (this.snapshot.running >= this.config.maxConcurrentTasks) {
            throw new Error(`Concurrent-task limit ${this.config.maxConcurrentTasks} reached.`);
        }
        if (this.snapshot.submitted >= this.config.maxTotalTasks) {
            throw new Error(`Total-task limit ${this.config.maxTotalTasks} reached.`);
        }
        const upperBoundUsd = conservativeTaskUpperBoundUsd(
            spec.resourceMode,
            this.config.maxTaskRuntimeSeconds,
            this.prices,
            this.config.ancillaryReservePerTaskUsd,
        );
        if (upperBoundUsd > this.config.maxExperimentCostUsd) {
            throw new Error(`Task upper bound $${upperBoundUsd.toFixed(6)} exceeds the per-experiment limit.`);
        }
        if (this.snapshot.accruedEstimatedUsd + this.snapshot.committedUpperBoundUsd + upperBoundUsd >
            this.config.maxAggregateCostUsd) {
            throw new Error(`Launch would exceed aggregate cost limit $${this.config.maxAggregateCostUsd.toFixed(2)}.`);
        }
        return upperBoundUsd;
    }

    launched(upperBoundUsd: number): void {
        this.snapshot.submitted += 1;
        this.snapshot.running += 1;
        this.snapshot.committedUpperBoundUsd += upperBoundUsd;
    }

    completed(upperBoundUsd: number, actualEstimatedUsd: number, successful: boolean): void {
        this.snapshot.running -= 1;
        this.snapshot.committedUpperBoundUsd -= upperBoundUsd;
        this.snapshot.accruedEstimatedUsd += actualEstimatedUsd;
        if (successful) {
            this.snapshot.succeeded += 1;
            this.snapshot.consecutiveFailures = 0;
        } else {
            this.snapshot.failed += 1;
            this.snapshot.consecutiveFailures += 1;
        }
        this.evaluateFailureCutoff();
    }

    halt(reason: string): void {
        this.snapshot.haltedReason = reason;
    }

    private evaluateFailureCutoff(): void {
        const attempts = this.snapshot.succeeded + this.snapshot.failed;
        const failureRate = attempts === 0 ? 0 : this.snapshot.failed / attempts;
        if (this.snapshot.consecutiveFailures >= this.config.consecutiveFailureCutoff) {
            this.halt(`${this.snapshot.consecutiveFailures} consecutive task failures.`);
        } else if (attempts >= this.config.minimumAttemptsBeforeFailureRateCutoff &&
            failureRate >= this.config.failureRateCutoff) {
            this.halt(`Task failure rate ${failureRate.toFixed(4)} reached cutoff ${this.config.failureRateCutoff}.`);
        }
    }
}
