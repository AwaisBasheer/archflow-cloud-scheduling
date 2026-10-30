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

## License and acknowledgements

The upstream root [LICENSE](LICENSE) is Apache License 2.0. The preserved upstream
`ts/package.json` declares MIT; this metadata discrepancy remains documented for
redistribution review. ChunkFunc authorship and Git history are retained.

The inherited ChunkFunc work acknowledges the Austrian Research Promotion Agency
(FFG), RapidREC project 903884, and Austrian Internet Stiftung NetIdee, LEO Trek
grant 7442.
