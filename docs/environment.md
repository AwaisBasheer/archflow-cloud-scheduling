# Environment & Setup Notes

## AWS Fargate
- Account/region: TBD
- ARM64 + x86_64 task definitions: TBD
- **Concurrency quota check (Days 1–7):** confirm Fargate on-demand vCPU quota covers the concurrency needed for primary-scale (Montage 1.0, ~469-task) experiments across 4 scheduling policies with repeats — not just a single-task smoke test. Record the requested/approved quota and date here.

## Container Images
- Multi-arch build command: TBD (`docker buildx build --platform linux/amd64,linux/arm64 ...`)
- Registry: TBD

## Local Dependencies
- Python version: TBD
- Key packages: TBD (pin exact versions in `requirements.txt`)

## Troubleshooting Log
Keep a running log here of anything that took real time to fix (build friction, quota delays, profiling variance, etc.) — required by the guide as part of Cutoff 3 documentation.

| Date | Issue | Resolution |
|------|-------|------------|
|      |       |            |
