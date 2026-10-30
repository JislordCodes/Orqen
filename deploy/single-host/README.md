# Single-host backend on AWS (free-plan friendly)

The cheapest real deployment: one EC2 `m7i-flex.large` (2 vCPU, 8 GB, free-plan eligible) runs
`docker-compose.prod.yml` (Caddy TLS + API + worker + Redis + per-project sandboxes). No domain is
needed: the Elastic IP gives a stable `https://api.<ip-with-dashes>.sslip.io`, and preview links
use `https://<token>.preview.<ip-with-dashes>.sslip.io` with on-demand certificates.
For the redundant multi-service setup use `infra/terraform` and `docs/DEPLOYMENT.md`.

## One-time setup
1. In the repo: Settings > Secrets and variables > Actions, add the secrets
   `AWS_CREDS` (`ACCESS_KEY_ID:SECRET_ACCESS_KEY`) and `NEBIUS_API_KEY`.
   Optional variables: `AWS_REGION` (default `eu-west-1`), `CORS_ORIGINS`, `MODEL_ID`.
2. Actions > "Deploy single host (AWS free plan)" > Run workflow > `deploy`.
   The run summary prints the API URL. First boot takes ~15 minutes (Docker install and image builds).
3. In Vercel set `VITE_API_URL` to that URL and redeploy the frontend.

## Day 2
- Every push to `main` touching `backend/`, `deploy/single-host/` or `docker-compose.prod.yml`
  redeploys (SSM runs `deploy/single-host/up.sh`: git pull, rebuild, restart).
- Shell on the host without SSH: `aws ssm start-session --target <instance-id>`.
  Logs: `/var/log/orqen-setup.log`, `cd /opt/orqen && docker compose -f docker-compose.prod.yml logs -f`.
- Change env (CORS, model, limits): edit the workflow variables and run `redeploy`.
- Tear everything down: run the workflow with `destroy`.

## Limits
- One build at a time (`MAX_CONCURRENT_RUNS=1`, 3 GB sandbox) on 8 GB RAM + 4 GB swap.
- No redundancy: a reboot keeps data (volumes on the 60 GB root disk); terminating the instance loses projects.
- `AUTH_MODE=dev`: anyone who finds the API can start runs on your LLM key. Switch to `AUTH_MODE=jwt`
  (see docs/ENV.md) before sharing the URL widely.
