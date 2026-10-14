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

## License and acknowledgements

The upstream root [LICENSE](LICENSE) is Apache License 2.0. The preserved upstream
`ts/package.json` declares MIT; this metadata discrepancy remains documented for
redistribution review. ChunkFunc authorship and Git history are retained.

The inherited ChunkFunc work acknowledges the Austrian Research Promotion Agency
(FFG), RapidREC project 903884, and Austrian Internet Stiftung NetIdee, LEO Trek
grant 7442.
