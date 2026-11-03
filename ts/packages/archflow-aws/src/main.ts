import { readFileSync, writeFileSync } from 'node:fs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient } from '@aws-sdk/client-ecs';
import { S3Client } from '@aws-sdk/client-s3';
import { executeRealDag } from './lib/dag-orchestrator';
import { FargateTaskRunner } from './lib/fargate-runner';
import { ExperimentCostGuardrail } from './lib/guardrail';
import { AwsPriceRates, CostGuardrailConfig, WorkflowNode } from './lib/model';

interface RunPlan {
    region: string;
    workflowId: string;
    schedulerId: string;
    deadlineSeconds: number;
    schedulerDecisionOverheadMs: number;
    prices: AwsPriceRates;
    guardrails: CostGuardrailConfig;
    nodes: WorkflowNode[];
    outputPath: string;
}

async function main(): Promise<void> {
    const planPath = process.argv[2];
    if (!planPath) {
        throw new Error('Usage: node main.js <real-aws-run-plan.json>');
    }
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RunPlan;
    const clientConfig = { region: plan.region, maxAttempts: 5 };
    const guardrail = new ExperimentCostGuardrail(plan.guardrails, plan.prices);
    const records: unknown[] = [];
    const runner = new FargateTaskRunner(
        new ECSClient(clientConfig),
        new CloudWatchLogsClient(clientConfig),
        new S3Client(clientConfig),
        guardrail,
        plan.prices,
        {
            pollIntervalMs: 3000,
            maximumRuntimeSeconds: plan.guardrails.maxTaskRuntimeSeconds,
            ancillaryReservePerTaskUsd: plan.guardrails.ancillaryReservePerTaskUsd,
            onTaskSubmitted: record => {
                records.push({ event: 'submitted', record });
                writeFileSync(`${plan.outputPath}.ledger.json`, JSON.stringify({ guardrail: guardrail.current(), records }, null, 2));
            },
            onTaskCompleted: record => {
                records.push({ event: 'completed', record });
                writeFileSync(`${plan.outputPath}.ledger.json`, JSON.stringify({ guardrail: guardrail.current(), records }, null, 2));
            },
        },
    );
    const result = await executeRealDag(plan.nodes, runner, {
        workflowId: plan.workflowId,
        schedulerId: plan.schedulerId,
        deadlineSeconds: plan.deadlineSeconds,
        schedulerDecisionOverheadMs: plan.schedulerDecisionOverheadMs,
        maxConcurrentTasks: plan.guardrails.maxConcurrentTasks,
    });
    writeFileSync(plan.outputPath, JSON.stringify({ result, guardrail: guardrail.current() }, null, 2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
});
