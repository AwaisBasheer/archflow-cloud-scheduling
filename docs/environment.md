# Environment & Setup Notes

## AWS Fargate
- Account/region:   
- ARM64 + x86_64 task definitions:   
- **Concurrency quota check (Days 1–7):** confirm Fargate on-demand vCPU quota covers the concurrency needed for primary-scale (Montage 1.0, ~469-task) experiments across 4 scheduling policies with repeats — not just a single-task smoke test. Record the requested/approved quota and date here.

## Container Images
- Multi-arch build command:    (`docker buildx build --platform linux/amd64,linux/arm64 ...`)
- Registry:   

## Local Dependencies
- Python version:   
- Key packages:    (pin exact versions in `requirements.txt`)

## Troubleshooting Log
Keep a running log here of anything that took real time to fix (build friction, quota delays, profiling variance, etc.) — required by the guide as part of Cutoff 3 documentation.

| Date | Issue | Resolution |
|------|-------|------------|
|      |       |            |
