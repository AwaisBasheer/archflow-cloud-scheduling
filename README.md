# ArchFlow-H

ArchFlow-H is a research prototype for deadline-constrained workflow scheduling
on AWS Fargate. It selects a CPU architecture and a CPU/memory mode for each task
instance. The repository contains the implementation, a ChunkFunc baseline
reproduction, controlled simulations, and measured AWS experiment evidence.

## Research question

Does joint selection of architecture and resource size reduce workflow cost
beyond the best scheduler restricted to one architecture, while meeting the same
workflow deadline?

The controlled comparison uses the same ArchFlow-H search algorithm with
architecture selection enabled or disabled. This distinguishes the effect of
architecture selection from the effect of a different resource-search heuristic.

## Source provenance

The project extends [ChunkFunc](https://github.com/polaris-slo-cloud/chunk-func),
pinned to commit `e0e7c277310c97d6628ece8aa9bb55368be74092`. The local branch
`baseline/chunkfunc-e0e7c277` identifies that reference. The original TypeScript
core, simulator, converter, and video-processing inputs are unchanged.

The ArchFlow experiments and baseline replays ran on **10 October 2026**. The local milestone
history was reconstructed on 16 November 2026, with assigned commit dates from
10 October through 16 November. Experiment timestamps inside the evidence retain
their original dates.

The recorded environment used Node.js 24.11.0, npm 11.6.1, Nx 17.1.3, and
TypeScript 5.2.2 on Linux x86_64. The original simulator supports Node.js 18 or
newer. The AWS analysis scripts use newer Node.js APIs; use Node.js 24 to reproduce
the complete analysis.

## ChunkFunc reproduction

The baseline replays the original VidPro coarse-grained, exhaustive profiling
traces. It compares ChunkFunc, SLAM, and StepConf across three input scenarios and
71 deadlines per scenario: 639 simulator executions and 213 cases per method.

| Method | Compliant cases | Reproduced SLO adherence | Published rounded adherence |
|---|---:|---:|---:|
| ChunkFunc | 213/213 | 100.00% | 100% |
| SLAM | 146/213 | 68.54% | 69% |
| StepConf | 166/213 | 77.93% | 78% |

All rates match at the publication's whole-percent precision. The stored
execution-time and cost pairs also match the corresponding upstream results.
This is a trace-replay reproduction using the authors' measurements. It does not
repeat the original function profiling on a cloud platform.

The deadline sweep uses a base of 77,439 ms, a 774-ms increment, and 35 values on
either side of the base. The range is 50,349–104,529 ms. The executable workflow
has seven active resource profiles; its 128-MiB profile is commented out. SLAM
uses the unchanged median-input training scenario.

The reproduction script verifies ancestry from the pinned commit and checks that
the original core, simulator, converter, VidPro inputs, and optimizer guide remain
unchanged. It records baseline and workspace commits separately.

Evidence: [comparison CSV](results/chunkfunc_reproduction.csv),
[case-level CSV](results/chunkfunc_reproduction_cases.csv),
[raw results](artifacts/reproduction/phase2/vidpro-gcf-max-execution-time/raw/),
and [raw SHA-256 manifest](artifacts/reproduction/phase2/vidpro-gcf-max-execution-time/raw-sha256.txt).

## Workflow and cost model

A directed acyclic graph (DAG) represents a workflow. Each task has a unique ID,
task class, predecessor/successor IDs, input or workload size, and performance
profiles. A profile records execution time, startup overhead, resource mode, and
data provenance. A resource mode records architecture, vCPU, and memory.

The event simulator releases a task after all its predecessors finish. Ready
tasks run concurrently, subject to an optional concurrency limit. Workflow
makespan is the maximum task finish time. Workflow cost includes every task,
including both sides of a parallel branch. Deterministic ordering resolves ties.

The simulated catalog has five sizes per architecture: 0.25/0.5, 0.5/1, 1/2, 2/4,
and 4/8, expressed as vCPU/memory. Both x86_64 and ARM64 are explicit mode
properties. The validator rejects invalid Fargate CPU/memory combinations.

For execution time `E`, startup overhead `H`, vCPU `V`, memory `M`, and the
architecture-specific rates `Rcpu` and `Rmem`:

```text
durationSeconds = E + H
billableSeconds = ceil(max(60, durationSeconds))
taskCostUsd = billableSeconds × (V × Rcpu + M × Rmem)
```

The simulation uses the captured `us-east-1` pricing configuration dated
10 October 2026. Simulation cost excludes public IPv4, transfer, storage, logs,
taxes, and discounts. The real AWS analysis adds measured public-IPv4 lifecycle
cost. Neither cost measure is invoice-confirmed.

## Fixed-architecture scheduler

`FixedArchitectureProportionalDeadlineScheduler` implements the ChunkFunc-style
Fargate baseline. It restricts candidates to x86_64 or ARM64, estimates downstream
critical-path durations, and allocates a proportional share of the remaining
deadline to each task. It selects the cheapest profile within that local budget,
or the fastest profile when no candidate fits.

The scheduler then simulates the complete workflow. If needed, it upgrades a
critical-path task using the lowest incremental cost per second of makespan
reduction. A remaining deadline violation is reported explicitly. This adapts
ChunkFunc's proportional-budget idea to offline Fargate tasks, explicit startup
time, and per-task billing.

## ARM profile assumptions

The earlier VidPro experiments map original GCF-like profiles onto representative
Fargate modes. They are labeled `chunkfunc-proxy` and include an assumed
two-second startup overhead. These values are not Fargate measurements.

ARM durations in the simulation phases are deterministic synthetic derivatives.
Seed `20261010` fixes per-task/per-mode jitter. The VidPro factors multiply x86
execution time by 0.95 for validation, 1.08 for cuts, and 0.90 for merge, with
±2% jitter. Startup time is unchanged. The neutral control uses factor 1.0 without
jitter. The ARM-dominant control uses factor 0.85 without jitter.

Every derived profile records its source, seed, base factor, jitter, and effective
factor. Real AWS profiles are labeled `measured-aws-fargate` and do not use these
synthetic factors.

## ArchFlow-H scheduling

ArchFlow-H minimizes the sum of task costs subject to the workflow deadline,
dependency constraints, available profiles, valid Fargate modes, and the optional
concurrency limit. Architecture and resource size are selected per task instance.

The heuristic:

1. Validates candidates and calculates their billed costs.
2. Selects the cheapest candidate independently for each task.
3. Simulates the complete DAG.
4. If the deadline is missed, evaluates faster one-task changes by full simulation.
5. Prefers actual makespan reduction, then non-increasing cost, then time saved
   per added dollar. It also permits progress across tied critical branches.
6. Once feasible, accepts cheaper one-task changes only if the deadline remains met.
7. Returns the final assignment, costs, critical path, slack, and accepted decisions.

If no feasible result is found, the scheduler returns its best encountered
schedule and the exact violation. This does not prove global infeasibility or
global cost optimality. The greedy refinement can stop at a one-task local minimum.

Full and architecture-restricted ArchFlow use the same implementation. Candidate
filtering is their only search-path difference. Scheduler process time is
measured separately and is excluded from simulated makespan.

## Controlled simulation results

The architecture-selection ablation runs three workloads, three deadline
conditions, and five methods: 45 simulations. It retains 43 feasible and two
infeasible outcomes. Full ArchFlow is compared with the cheaper deadline-feasible
restricted ArchFlow result for the same case.

| Workload | Tight deadline | Moderate deadline | Relaxed deadline |
|---|---:|---:|---:|
| Mixed VidPro proxy | 52 s | 56 s | 220 s |
| Equal-performance fork/join | 50 s | 80 s | 180 s |
| ARM-dominant fork/join | 45 s | 75 s | 160 s |

Full architecture selection reduces cost in one of nine cases and ties in eight.
In tight VidPro, it selects two ARM and two x86 tasks, costs `$0.007405635`, and
finishes in `51.501561` seconds. The best feasible restricted result is x86-only
at `$0.007611270` and `51.795` seconds: a **2.701717%** modeled saving. ARM-only
ArchFlow misses that deadline by `2.522261` seconds.

In the other eight cases, full ArchFlow matches ARM-restricted ArchFlow. Earlier
resource-search comparisons reported 28.85% and 27.27% modeled savings, but those
comparisons do not isolate architecture choice. All these simulation results
depend on proxy or synthetic performance data.

Evidence: [ablation CSV](results/ablation_results.csv),
[cost figure](results/ablation_cost_comparison.svg),
[deadline figure](results/ablation_makespan_deadline.svg), and
[frozen experiment inputs and outputs](artifacts/archflow/phase6/).

## AWS execution method

The real workflow has five data-dependent nodes:

```text
                 +-> cut-a -+
generate-source -+          +-> merge -> validate
                 +-> cut-b -+
```

The source generates a deterministic 24-second, 1280×720 H.264 stream. The cut
branches produce 12-second segments. Merge reconstructs the stream. Validation
checks codec, dimensions, duration, 720 frames, byte count, and SHA-256.

Each DAG node is one ECS Fargate task with downloader, worker, and uploader
containers. Intermediates use private S3 storage. Successors start only after
their predecessors succeed and expected outputs exist. CloudWatch markers record
application timestamps and actual architecture. ECS records supply image-pull
and task-lifecycle timestamps.

The measured experiment uses `us-east-1`, a 420-second deadline, and concurrency
two. Worker and transfer images are pinned to immutable multi-architecture digests:

- `lscr.io/linuxserver/ffmpeg@sha256:aea59a11c54291ac456bb2d67000445e5a8994f70bc3d96cdc29f022fbbf89fb`
- `amazon/aws-cli@sha256:ce44b800602264c12298bbf3399055a4cefdb9ed4a098abe564afe26e7071bce`

The execution package implements task/time/cost limits, failure cutoffs, output
checks, and tracked-task cleanup. It uses the AWS SDK default credential chain.
Recorded live operations used a connected AWS control-plane session because the
original host had no local credential session. The reusable TypeScript runner
was not the launcher used for those recorded executions.

## Measured profiles

The initial smoke matrix has eight successful tasks: two architectures, two
resource sizes, and two repetitions per cell.

| Architecture | vCPU / GiB | Samples | Mean application time | Mean lifecycle |
|---|---|---:|---:|---:|
| ARM64 | 0.25 / 0.5 | 2 | 34.0255 s | 77.414166 s |
| x86_64 | 0.25 / 0.5 | 2 | 66.8430 s | 120.786872 s |
| ARM64 | 1 / 2 | 2 | 13.6685 s | 58.369770 s |
| x86_64 | 1 / 2 | 2 | 16.8050 s | 64.708987 s |

The final training matrix adds ten low-mode task-class observations. The earlier
1-vCPU/2-GiB workflows supply the second tier. Source, merge, and validation have
one low-mode observation per architecture; cuts have two. These small samples
are recorded with observation IDs and summary statistics.

The five scheduling plans were frozen before holdout execution. The subsequent
35 successful holdout tasks were not used to refit the training profiles.

Evidence: [training matrix](artifacts/archflow/aws/profiles/measured-ffmpeg-task-matrix.json),
[observations](artifacts/archflow/aws/profiles/ffmpeg-task-profile-observations.csv),
and [frozen plans](artifacts/archflow/aws/final/plans/).

## Real AWS results

The final matrix has one complete run per method. Full ArchFlow-H and fixed-ARM
ArchFlow each have a second matched run: seven workflows and 35 successful
intended tasks in total.

| Method | Runs | Assignment | Mean modeled cost (USD) | Mean observed wall makespan | 420-s compliance |
|---|---:|---|---:|---:|---:|
| ChunkFunc-style x86 | 1 | All x86, 0.25/0.5 | 0.002554437 | 828.688 s | 0% |
| ChunkFunc-style ARM | 1 | All ARM, 0.25/0.5 | 0.001838196 | 969.218 s | 0% |
| ArchFlow fixed x86 | 1 | All x86, 0.25/0.5 | 0.002590376 | 933.584 s | 0% |
| ArchFlow fixed ARM | 2 | All ARM, 0.25/0.5 | 0.001773969 | 773.313 s | 0% |
| Full ArchFlow-H | 2 | All ARM, 0.25/0.5 | 0.001676876 | 570.544 s | 0% |

**Joint architecture selection demonstrated no incremental real-AWS benefit in
this workload.** Full ArchFlow selected the same all-ARM assignment as fixed-ARM
ArchFlow. The apparent saving changed from +11.634454% to −1.997047% between
matched repetitions. Differences between identical assignments are execution
variability.

Every observed workflow missed the deadline. Thus, no deadline-constrained
real-cost-saving claim is supported. All 35 intended tasks and 105 containers
completed successfully. Three extra attempts failed before application startup
during public-registry pulls; unchanged retries succeeded. Their records and
separate cost estimates are retained.

Across 35 holdout tasks, lifecycle MAE is **9.681600 s** and lifecycle MAPE is
**8.791423%**. Application-marker MAE is 5.528257 s and MAPE is 12.679313%.
Dependency-normalized workflow MAE is 41.568143 s.

### Timing and billing interpretation

Observed wall makespan runs from the first source task's creation to validation
stop. It includes startup, image pulls, transfers, and actual remote dependency
release gaps. This is the primary deadline measure.

The dependency-normalized diagnostic sums measured task lifecycles along the DAG
with immediate successor release and parallel cuts. Its mean is 326.619 s for
full ArchFlow and 364.891 s for fixed ARM. These values are diagnostic estimates,
not observed end-to-end executions.

Real compute/memory billing uses `ceil(max(60, stoppedAt - pullStartedAt))`.
Public-IPv4 cost uses the recorded task lifecycle. Workflow costs include
successful intended tasks; failed pull attempts are accounted for separately.
Total modeled provider usage across all recorded experiments is `$0.032080554429`;
the conservative total with ancillary reserves is `$0.118080554429`.

The earlier fixed 1-vCPU/2-GiB pair completed within 420 seconds: ARM at 357.955248 s
and `$0.003709478968`, x86 at 399.019988 s and `$0.004808886453`. That pair is
training/calibration evidence and is excluded from the final holdout comparison.

Final cleanup records show an inactive/empty cluster and no active experiment
task definitions, bucket, log group, security group, scoped IAM roles, or ECR
repositories. The repository retains exported evidence; infrastructure must be
provisioned again for new live experiments.

## Reproduce and verify

From the repository root, install the locked dependencies and verify the code:

```sh
cd ts
npm ci
npx nx run-many -t build,lint -p archflow-core,archflow-sim,archflow-aws --parallel=1
npx nx run-many -t test -p core,chunk-func-sim,results-converter,archflow-core,archflow-sim,archflow-aws --runInBand --parallel=1
cd ..
```

The test inventory has 67 tests across 12 suites: 19 original core tests,
42 ArchFlow core tests, and six AWS execution tests. The simulator/converter CLI
targets currently accept having no dedicated tests.

Regenerate the baseline and controlled simulations locally:

```sh
./scripts/reproduce_chunkfunc.sh
./scripts/run_phase3_x86_baseline.sh
./scripts/run_phase4_arm_baseline.sh
./scripts/run_phase5_archflow_h.sh
./scripts/run_phase6_ablations.sh
```

The baseline wrapper also requires Bash, `bc`, `sed`, and Git. Workflow times,
costs, assignments, and feasibility are deterministic. Measured scheduler process
time varies between runs. Generated logs, scenario copies, metadata, and Markdown
reports are ignored; raw results, manifests, CSVs, and figures are versioned.

Verify the preserved real-cloud evidence without AWS credentials:

```sh
node scripts/verify_real_aws_artifacts.mjs
node scripts/verify_final_real_aws_artifacts.mjs
```

Regenerate the final CSVs and figures with
`node scripts/analyze_real_aws_final.mjs`. This updates the analysis generation
timestamp. Preserve the frozen plans when analyzing historical holdouts.
`scripts/generate_real_aws_plans.mjs` generates a new training matrix and plans;
its new timestamps must not be presented as pre-existing historical plans.

New AWS executions require provisioned task definitions, network/storage/log
resources, fresh AWS credentials, and a complete execution plan for
`node ts/dist/packages/archflow-aws/main.js <execution-plan.json>`. The archived
scheduler plans record resource decisions and do not contain a complete live
execution configuration.

## Evidence and repository structure

| Path | Content |
|---|---|
| `ts/packages/archflow-core/` | Model, simulator, billing, adapters, and schedulers |
| `ts/packages/archflow-sim/` | Manifest-driven experiment runner |
| `ts/packages/archflow-aws/` | ECS task runner, DAG execution, and cost limits |
| `ts/scenarios/archflow/` | Frozen modes, rates, assumptions, and experiment plans |
| `artifacts/reproduction/` | Original ChunkFunc replay evidence |
| `artifacts/archflow/phase3/`–`phase6/` | Simulation outputs and effective profiles |
| `artifacts/archflow/aws/` | Measured profiles, task records, plans, and results |
| `results/` | Baseline/ablation tables and figures |
| `scripts/` | Reproduction, analysis, and evidence verification |
| `go/`, `py/`, `testbed/`, `jupyter/` | Inherited profiling system, workloads, and notebooks |

The final [workflow table](artifacts/archflow/aws/final/results/workflow-results.csv),
[task observations](artifacts/archflow/aws/final/results/task-observations.csv),
[prediction errors](artifacts/archflow/aws/final/results/prediction-errors.csv),
[matched ablations](artifacts/archflow/aws/final/results/architecture-ablation.csv),
[failed attempts](artifacts/archflow/aws/final/results/failed-attempts.csv), and
[six figures](artifacts/archflow/aws/final/results/figures/) derive from the raw
snapshot and frozen plans.

| Evidence snapshot | SHA-256 |
|---|---|
| `artifacts/archflow/aws/task-telemetry/aws-control-plane-export.json` | `0301c7432902fb8a90da568ee0f5ba85db32ab1afa031c802cbbc40ca6096084` |
| `artifacts/archflow/aws/final/raw/final-evaluation-all.json` | `f36637c628fbcc47f3ddcac6f9da8fdc2aa41008e068b84c2a06452de9777142` |
| `artifacts/archflow/aws/final/raw/final-infrastructure-manifest.json` | `395203ceb53de17ab89aed6779a02e79117772a389ff023cc1e17b837169bff7` |

Original component deployment instructions remain in [docs/](docs/), including
the [Knative profiler guide](docs/profiler.md) and
[workflow simulator guide](docs/workflow-optimizer.md).

## Limitations

- The positive architecture-selection case uses proxy/synthetic profiles.
- The measured experiment uses one FFmpeg DAG, one deadline, and two resource tiers.
- Training cells have few observations. Only two methods have matched repeats.
- Remote dependency-release latency materially affects the observed wall results.
- Identical selected architectures prevent attribution of real differences to
  architecture selection. No significance or general ARM superiority is claimed.
- The greedy scheduler does not establish global optimality or infeasibility.
- Costs use captured public rates rather than reconciled AWS invoices.
- No real Montage or other scientific workflow was evaluated.

## License and acknowledgements

The upstream root [LICENSE](LICENSE) is Apache License 2.0. The preserved upstream
`ts/package.json` declares MIT; this metadata discrepancy remains documented for
redistribution review. ChunkFunc authorship and Git history are retained.

The inherited ChunkFunc work acknowledges the Austrian Research Promotion Agency
(FFG), RapidREC project 903884, and Austrian Internet Stiftung NetIdee, LEO Trek
grant 7442.
