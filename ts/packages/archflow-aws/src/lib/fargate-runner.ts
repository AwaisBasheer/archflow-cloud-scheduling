import {
    DescribeTasksCommand,
    ECSClient,
    KeyValuePair,
    RunTaskCommand,
    StopTaskCommand,
    Task,
} from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { calculateLifecycleDurations, estimateProviderCost } from './cost';
import { TaskExecutor } from './dag-orchestrator';
import { ExperimentCostGuardrail } from './guardrail';
import { lifecycleFromTask, parseApplicationMarkers } from './lifecycle';
import {
    AwsPriceRates,
    FargateLaunchSpec,
    FargateTaskRecord,
    OutputValidation,
    WorkflowNode,
} from './model';

export interface FargateRunnerOptions {
    pollIntervalMs: number;
    maximumRuntimeSeconds: number;
    ancillaryReservePerTaskUsd: number;
    onTaskSubmitted?: (record: FargateTaskRecord) => Promise<void> | void;
    onTaskCompleted?: (record: FargateTaskRecord) => Promise<void> | void;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function taskIdFromArn(taskArn: string): string {
    return taskArn.slice(taskArn.lastIndexOf('/') + 1);
}

function environmentPairs(values: Record<string, string> | undefined): KeyValuePair[] {
    return Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }));
}

export class FargateTaskRunner implements TaskExecutor {
    private readonly tracked = new Map<string, { cluster: string; terminal: boolean }>();

    constructor(
        private readonly ecs: ECSClient,
        private readonly logs: CloudWatchLogsClient,
        private readonly s3: S3Client,
        private readonly guardrail: ExperimentCostGuardrail,
        private readonly prices: AwsPriceRates,
        private readonly options: FargateRunnerOptions,
    ) {}

    async execute(node: WorkflowNode): Promise<FargateTaskRecord> {
        return this.run(node.launchSpec);
    }

    async run(spec: FargateLaunchSpec): Promise<FargateTaskRecord> {
        const submittedAt = new Date().toISOString();
        const upperBoundUsd = this.guardrail.admit(spec);
        const response = await this.ecs.send(new RunTaskCommand({
            cluster: spec.cluster,
            launchType: 'FARGATE',
            platformVersion: 'LATEST',
            taskDefinition: spec.taskDefinition,
            count: 1,
            enableECSManagedTags: true,
            propagateTags: 'TASK_DEFINITION',
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets: spec.network.subnetIds,
                    securityGroups: spec.network.securityGroupIds,
                    assignPublicIp: spec.network.assignPublicIp ? 'ENABLED' : 'DISABLED',
                },
            },
            overrides: {
                containerOverrides: [{
                    name: spec.containerName,
                    command: spec.command,
                    environment: environmentPairs(spec.environment),
                }],
            },
            tags: Object.entries(spec.tags).map(([key, value]) => ({ key, value })),
            startedBy: `archflow-${spec.experimentId}`.slice(0, 36),
        }));
        if ((response.failures?.length ?? 0) > 0 || response.tasks?.length !== 1 || !response.tasks[0].taskArn) {
            throw new Error(`RunTask failed: ${JSON.stringify(response.failures ?? [])}`);
        }
        const taskArn = response.tasks[0].taskArn;
        this.tracked.set(taskArn, { cluster: spec.cluster, terminal: false });
        this.guardrail.launched(upperBoundUsd);
        let finalTask: Task | undefined;
        let timedOut = false;
        const deadline = Date.now() + this.options.maximumRuntimeSeconds * 1000;
        try {
            const initial = this.emptyRecord(spec, submittedAt, taskArn, response.tasks[0]);
            await this.options.onTaskSubmitted?.(initial);

            while (Date.now() < deadline) {
                const described = await this.ecs.send(new DescribeTasksCommand({
                    cluster: spec.cluster,
                    tasks: [taskArn],
                    include: ['TAGS'],
                }));
                if ((described.failures?.length ?? 0) > 0 || described.tasks?.length !== 1) {
                    throw new Error(`DescribeTasks failed for ${taskArn}: ${JSON.stringify(described.failures ?? [])}`);
                }
                finalTask = described.tasks[0];
                if (finalTask.lastStatus === 'STOPPED') {
                    break;
                }
                await sleep(this.options.pollIntervalMs);
            }
            if (!finalTask || finalTask.lastStatus !== 'STOPPED') {
                timedOut = true;
                await this.ecs.send(new StopTaskCommand({
                    cluster: spec.cluster,
                    task: taskArn,
                    reason: `ArchFlow timeout after ${this.options.maximumRuntimeSeconds} seconds`,
                }));
                finalTask = await this.waitForStopped(spec.cluster, taskArn);
            }
            const record = await this.completeRecord(spec, submittedAt, taskArn, finalTask, timedOut);
            this.tracked.set(taskArn, { cluster: spec.cluster, terminal: true });
            this.guardrail.completed(upperBoundUsd, record.cost.totalUsd, record.successful);
            await this.options.onTaskCompleted?.(record);
            return record;
        } catch (error) {
            await this.stopOne(spec.cluster, taskArn, `ArchFlow runner error: ${error instanceof Error ? error.message : String(error)}`);
            this.guardrail.completed(upperBoundUsd, upperBoundUsd, false);
            throw error;
        }
    }

    async stopTracked(reason: string): Promise<void> {
        this.guardrail.halt(reason);
        await Promise.all([...this.tracked.entries()]
            .filter(([, state]) => !state.terminal)
            .map(([taskArn, state]) => this.stopOne(state.cluster, taskArn, reason)));
    }

    private async waitForStopped(cluster: string, taskArn: string): Promise<Task> {
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const described = await this.ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
            const task = described.tasks?.[0];
            if (task?.lastStatus === 'STOPPED') {
                return task;
            }
            await sleep(this.options.pollIntervalMs);
        }
        throw new Error(`Task ${taskArn} did not reach STOPPED after stop request.`);
    }

    private async stopOne(cluster: string, taskArn: string, reason: string): Promise<void> {
        try {
            await this.ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason: reason.slice(0, 255) }));
        } catch {
            // Cleanup is best effort; inventory verification handles any remaining task.
        }
    }

    private emptyRecord(
        spec: FargateLaunchSpec,
        submittedAt: string,
        taskArn: string,
        task: Task,
    ): FargateTaskRecord {
        const durations = calculateLifecycleDurations({ submittedAt }, this.prices.minimumBillableSeconds);
        return {
            schemaVersion: 1,
            experimentId: spec.experimentId,
            runId: spec.runId,
            taskId: spec.taskId,
            taskClass: spec.taskClass,
            taskArn,
            taskDefinitionArn: task.taskDefinitionArn,
            architecture: spec.resourceMode.architecture,
            cpuUnits: spec.resourceMode.cpuUnits,
            memoryMiB: spec.resourceMode.memoryMiB,
            lastStatus: task.lastStatus ?? 'SUBMITTED',
            lifecycle: { submittedAt },
            durations,
            cost: estimateProviderCost(
                spec.resourceMode,
                durations,
                this.prices,
                this.options.ancillaryReservePerTaskUsd,
                spec.network.assignPublicIp,
            ),
            outputValidation: [],
            logMessages: [],
            successful: false,
            timedOut: false,
        };
    }

    private async completeRecord(
        spec: FargateLaunchSpec,
        submittedAt: string,
        taskArn: string,
        task: Task,
        timedOut: boolean,
    ): Promise<FargateTaskRecord> {
        const container = task.containers?.find(item => item.name === spec.containerName) ?? task.containers?.[0];
        const logStreamName = `${spec.logStreamPrefix}/${spec.containerName}/${taskIdFromArn(taskArn)}`;
        const logMessages = await this.readLogs(spec.logGroupName, logStreamName);
        const markers = parseApplicationMarkers(logMessages);
        const lifecycle = {
            ...lifecycleFromTask(task, submittedAt),
            applicationStartedAt: markers.applicationStartedAt,
            applicationEndedAt: markers.applicationEndedAt,
        };
        const durations = calculateLifecycleDurations(lifecycle, this.prices.minimumBillableSeconds);
        const outputValidation = await Promise.all((spec.expectedOutputs ?? []).map(output => this.validateOutput(output)));
        const successful = !timedOut && container?.exitCode === 0 && outputValidation.every(output => output.exists);
        return {
            schemaVersion: 1,
            experimentId: spec.experimentId,
            runId: spec.runId,
            taskId: spec.taskId,
            taskClass: spec.taskClass,
            taskArn,
            taskDefinitionArn: task.taskDefinitionArn,
            architecture: spec.resourceMode.architecture,
            cpuUnits: spec.resourceMode.cpuUnits,
            memoryMiB: spec.resourceMode.memoryMiB,
            actualArchitecture: markers.actualArchitecture,
            ffmpegVersion: markers.ffmpegVersion,
            lastStatus: task.lastStatus ?? 'UNKNOWN',
            stoppedReason: task.stoppedReason,
            stopCode: task.stopCode,
            exitCode: container?.exitCode,
            containerReason: container?.reason,
            lifecycle,
            durations,
            cost: estimateProviderCost(
                spec.resourceMode,
                durations,
                this.prices,
                this.options.ancillaryReservePerTaskUsd,
                spec.network.assignPublicIp,
            ),
            outputValidation,
            logStreamName,
            logMessages,
            successful,
            timedOut,
        };
    }

    private async readLogs(logGroupName: string, logStreamName: string): Promise<string[]> {
        try {
            const response = await this.logs.send(new GetLogEventsCommand({
                logGroupName,
                logStreamName,
                startFromHead: true,
            }));
            return response.events?.flatMap(event => event.message ? [event.message] : []) ?? [];
        } catch {
            return [];
        }
    }

    private async validateOutput(output: { bucket: string; key: string; minimumBytes?: number }): Promise<OutputValidation> {
        try {
            const response = await this.s3.send(new HeadObjectCommand({ Bucket: output.bucket, Key: output.key }));
            const sizeBytes = response.ContentLength;
            return {
                bucket: output.bucket,
                key: output.key,
                exists: sizeBytes !== undefined && sizeBytes >= (output.minimumBytes ?? 1),
                sizeBytes,
                etag: response.ETag,
                checksumSha256: response.ChecksumSHA256,
            };
        } catch (error) {
            return {
                bucket: output.bucket,
                key: output.key,
                exists: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
