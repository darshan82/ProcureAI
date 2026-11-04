# ProcureAI: Enterprise AI Procurement Platform

An end-to-end, production-style **LangChain / LangGraph** platform for procurement: buyers publish tenders and award contracts,
suppliers submit bids, and everyone can ask an AI agent about tenders and the contracts behind them.

It runs **fully offline without an OpenAI key** (built-in mock LLM + hash embeddings), and switches to OpenAI the moment you add one.

```
 Browser (React + Vite)  ──►  nginx  ──►  API gateway (Express + TypeScript)
                                            │  JWT + RBAC ─ prompt-injection guard ─ PII scrubber
                                            │  Redis semantic cache (HNSW, cosine ≥ 0.92)
                                            │  LangGraph supervisor agent ──► Zod-typed tools ──► MongoDB
                                            │        └─ human-in-the-loop interrupt (award_tender)
                                            └─ upload: stream ─► S3 ─► Kafka "document.ingest" ─► 202 Accepted
                                                                         │
                         Ingestion worker (Kafka consumer) ◄─────────────┘
                         S3 stream → PDF parse → overlapping chunks → batch embeddings → MongoDB vectors
                         → invalidate semantic cache
```

## Screenshots

| Agent with HITL approval, PII + guardrails | Async document ingestion |
|---|---|
| ![chat](docs/screenshots/4-chat.png) | ![documents](docs/screenshots/2-documents.png) |
| **Platform: cache, guardrails, audit log** | **Login (BUYER / SUPPLIER)** |
| ![platform](docs/screenshots/5-platform.png) | ![login](docs/screenshots/1-login.png) |

## Quick start

```bash
cd procurement-ai-platform
cp .env.example .env        # optional: put your OPENAI_API_KEY in .env (git-ignored)
docker compose up -d --build
```

Open **http://localhost:8080** and click **Buyer** or **Supplier** (password `demo123`).

Run the three scripted live demos (Node 18+):

```bash
node scripts/demo.mjs all       # or: agent | security | ingest
```

| Service | URL |
|---|---|
| Web app | http://localhost:8080 |
| API | http://localhost:4000 (`/ready` shows dependencies + LLM mode) |
| Kafka (host listener) | localhost:29092 |
| MongoDB / Redis / S3 (LocalStack) | localhost:27017 / 6379 / 4566 |

### Adding your OpenAI key later
Edit `.env` → `OPENAI_API_KEY=sk-...`, then `docker compose up -d api worker`.
The agent then uses `gpt-4o-mini` with real tool calling, and embeddings switch to `text-embedding-3-small` (1536-d).
Re-upload documents after switching so they're embedded with the new model.
Optional: `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY` to trace every graph run in LangSmith.

> `.env` is in `.gitignore`. Never commit real keys.

## What's inside

| Capability | Where |
|---|---|
| LangGraph state schema (messages, intent, toolsUsed, approval, piiRedactions) | `apps/api/src/agent/state.ts` |
| Supervisor graph, conditional `execute_tools` routing, HITL `interrupt()` + resume | `apps/api/src/agent/graph.ts`, `runner.ts` |
| Zod-typed tools (`create_tender_db`, `submit_bid`, `award_tender`, `search_documents`, …) with in-tool RBAC | `apps/api/src/agent/tools.ts` |
| Offline mock LLM that emits real `tool_calls` | `apps/api/src/agent/mockLlm.ts` |
| Prompt-injection guardrail middleware | `apps/api/src/lib/guardrails.ts`, `middleware/guardrails.ts` |
| Real-time PII scrubbing before LLM egress (user input **and** tool outputs) | `apps/api/src/lib/pii.ts`, `agent/graph.ts` |
| JWT auth + RBAC (BUYER vs SUPPLIER) | `apps/api/src/auth/jwt.ts`, `middleware/auth.ts` |
| Streaming upload → S3 → Kafka producer → `202 Accepted` | `apps/api/src/routes/documents.ts`, `services/kafka.ts` |
| Kafka consumer: S3 stream, PDF parse, overlapping chunker, batch embeddings, Mongo bulk upsert | `apps/worker/src/*` |
| RAG retrieval (Atlas `$vectorSearch` or local cosine fallback) | `apps/api/src/services/retriever.ts` |
| Redis HNSW semantic cache, write-through + invalidation | `apps/api/src/services/semanticCache.ts` |
| Multi-stage Alpine Dockerfiles, non-root, health checks | `apps/*/Dockerfile` |
| Compose orchestration with health-gated startup | `docker-compose.yml` |
| ECS Fargate task definitions + ECR deploy script | `infra/aws/` |
| Live demo CLI scripts | `scripts/demo.mjs` |
| React UI: chat with trace/cache/PII badges, approval card, tenders, document upload, platform/audit | `apps/web/src/` |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local development without Docker for the apps

```bash
docker compose up -d mongo redis kafka s3
cd apps/api    && npm i && S3_ENDPOINT=http://localhost:4566 S3_ACCESS_KEY_ID=test S3_SECRET_ACCESS_KEY=test npm run dev
cd apps/worker && npm i && S3_ENDPOINT=http://localhost:4566 S3_ACCESS_KEY_ID=test S3_SECRET_ACCESS_KEY=test npm run dev
cd apps/web    && npm i && npm run dev     # http://localhost:5173, proxies /api → :4000
```

Tests: `cd apps/api && npm test` (guardrails, PII, intent, embeddings).

## Demo accounts

| Email | Role | Password |
|---|---|---|
| buyer@acme.test | BUYER | demo123 |
| supplier@globex.test | SUPPLIER | demo123 |
| supplier@initech.test | SUPPLIER | demo123 |
