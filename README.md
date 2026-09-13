# ArchFlow: Task-Instance-Level CPU-Architecture and Resource-Mode Scheduling for Scientific Workflows on Serverless Containers

> Status: research in progress (Cloud Computing 100-Day Research Assignment, Fall 2026)

## Overview
ArchFlow is a deadline-constrained, cost-aware scheduler that jointly selects CPU architecture (ARM64 vs. x86_64) and container resource tier for each **task instance** in a scientific DAG workflow (Montage), executed on AWS Fargate. This repository contains the scheduler implementation, profiling harness, baseline schedulers, experiment scripts, and result-regeneration instructions for the accompanying manuscript.

**Research Questions**
- RQ1: How does cost–performance affinity across ARM64/x86_64 and resource tiers vary among task classes?
- RQ2 (primary): Can task-instance-level joint architecture/resource scheduling reduce monetary cost vs. uniform, HEFT, and BDHEFT-style baselines under a deadline?
- RQ3 (stretch): Does online re-planning recover schedule quality when real execution deviates from the plan?

## Repository Structure
```
.
├── src/                # ArchFlow-H scheduler, baselines (HEFT, BDHEFT-style, uniform), CP-SAT reference model
├── experiments/         # Experiment driver scripts (profiling runs, scheduling runs, repeats)
├── configs/             # Task-class parameters, Fargate resource-tier/pricing tables, deadline settings
├── data/                # Montage DAG definitions, profiling results, raw execution logs (or generation instructions — see below)
├── figures/             # Scripts that regenerate every figure/table in the manuscript from data/
└── docs/                # Setup notes, quota-request records, troubleshooting log
```

## Environment / Dependencies
- Python (version + package manager TBD — pin in `requirements.txt` / `environment.yml` once code lands)
- AWS CLI configured with Fargate access (ARM64 + x86_64 task definitions)
- Docker (multi-arch image builds via `buildx`)
- See `docs/environment.md` for exact versions once finalized.

## Dataset / Workload
- Montage astronomy workflow, generated via the [Pegasus Workflow Generator](https://pegasus.isi.edu/) (or equivalent DAG source — confirm and link here).
- Primary evaluation scale: Montage 1.0 (~469 tasks). Pilot scale: Montage 0.25 (~43 tasks), used for debugging only.
- Generation/access instructions: *(fill in once the exact generator/config is fixed)*.

## Reproducing Results
1. Build and push multi-arch container images: `scripts/build_images.sh` *(TBD)*
2. Run the profiling pass to populate `data/profiling/`: `experiments/run_profiling.py` *(TBD)*
3. Run each scheduling policy (uniform, HEFT, BDHEFT-style, ArchFlow-H) against the target DAG: `experiments/run_schedule.py --policy <name> --scale <montage_scale>` *(TBD)*
4. Regenerate all manuscript figures/tables from logged results: `figures/make_all.py` *(TBD)*

*(This section will be filled in with exact commands as the codebase is built — keep it current after every experiment change; a grader/reviewer should be able to follow it without asking a question.)*

## Results
Summary tables/figures will be added here as they're produced, with pointers to the exact script + data that generated each one.

## License
See `LICENSE` (MIT, unless the group decides otherwise).

## Citation
Citation details (BibTeX) will be added once the manuscript is submitted.

## Security / Data Handling
No AWS credentials, API keys, or account secrets are stored in this repository. AWS access for reproduction should be configured locally via the AWS CLI / environment variables, never committed.

## Team
- Primary Researcher: *(name, roll number)*
- Co-Researcher: *(name, roll number)*
- Course: Cloud Computing, 100-Day Research Assignment, Group G__

---
Reproducibility: The code and reproducibility materials for this study are publicly available at: https://github.com/USERNAME/REPOSITORY
