# Operations runbook

## Onboarding a new customer (tenant)
1. Copy `apps/api/tenants/acme.json` to `<tenant>.json`. Set models, PII policy (`block` for regulated data), enabled tools, approval rules, limits and webhooks. Open a PR: the schema is validated on boot, and CI runs the evals.
   For a pilot you can skip the PR and use **Admin → Onboard customer** (same schema).
2. Map the customer's IdP (OIDC) org/group claims to `tenantId` and role (BUYER / SUPPLIER).
3. Agree on quality gates with the customer: add their real questions to `evals/dataset.jsonl` and tighten `GATES` in `evals/run.mjs`.
4. Have them verify webhook signatures (docs/INTEGRATIONS.md) and send a test event (create a tender).
5. Set the monthly budget and rate limit; watch the **TenantBudgetBurn** alert in week 1.

## Alerts (infra/observability/alerts.yml)
| Alert | Meaning | Action |
|---|---|---|
| LLMCircuitOpen | a model failed 3× in a row; traffic is on the next model in the chain | check provider status; `GET /api/admin/llm`; circuits half-open automatically after 30 s |
| AgentLatencyP95High | p95 turn latency > 8 s | check `llm_request_duration_seconds` by model; consider a faster model first in the chain or a lower cache threshold |
| WebhooksDeadLettering | customer endpoint failing | `Admin → Integrations` shows the last error; after the customer fixes it, **Replay** |
| TenantBudgetBurn | > $2/h for a tenant | check for loops in `agent_tool_calls_total`; lower the rate limit or budget |
| GuardrailAttackSpike | many blocked prompts | check `audit_log` for `guardrail.blocked` by actor; disable the user at the IdP |

## Common tasks
- **Raise a tenant's limits:** `PATCH /api/admin/tenants/<id>/settings {"limits": {...}}` (applies within 15 s).
- **Flush a tenant's answer cache** after a data fix: a BUYER calls `DELETE /api/chat/cache`, or any write tool does it automatically.
- **Reprocess a document:** re-upload it; ingestion is idempotent per document id.
- **Resume after a restart:** paused approvals are checkpointed in MongoDB (`agent_checkpoints`), so users can approve after an API restart or on another replica.
- **Upgrade from v1 (single-tenant):** the `2026-11-v2-multitenancy` migration backfills existing data into `LEGACY_TENANT_ID` (default `acme`) on first boot.
