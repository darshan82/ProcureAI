# Architecture & design decisions

## Request path: chat
1. **nginx** serves the SPA and proxies `/api` to the API (uploads are streamed, not buffered).
2. **JWT auth** (`requireAuth`) → `req.user = { sub, role }`.
3. **Prompt-injection guard** blocks known override / jailbreak / exfiltration patterns with HTTP 422 and writes an audit event.
4. **PII scrubber** redacts emails, phones, cards, IBANs, SSNs from the message *before* it reaches the agent.
5. **Semantic cache interceptor**: for read-only intents, embed the query and run `KNN 1` on the Redis HNSW index,
   filtered by role. Similarity ≥ 0.92 returns the cached answer in a few milliseconds without calling the LLM.
6. **LangGraph agent** (`classify_intent → supervisor ⇄ execute_tools`, with `human_review` for sensitive tools).
   The supervisor only gets tools allowed for the caller's role, and every tool re-checks the role (defence in depth).
   All messages are scrubbed again before LLM egress (tool outputs can contain PII too).
7. **Write-through / invalidation**: read-only answers that used tools are cached; any mutating tool flushes the cache.

## Human-in-the-loop
`award_tender` routes to `human_review`, which calls `interrupt()`. The checkpoint is saved (MemorySaver; swap for
`@langchain/langgraph-checkpoint-mongodb` in production), the API returns **202 awaiting_approval**, and only a BUYER can
`POST /api/chat/resume { approved }`. Rejection injects a `ToolMessage` so the transcript stays valid and the model can
explain what happened.

## Async ingestion
`POST /api/documents` streams multipart → S3 multipart upload (busboy + `@aws-sdk/lib-storage`), stores job metadata,
publishes `document.ingest` (keyed by documentId), returns **202 + statusUrl**. The worker:
S3 `GetObject` stream → temp file (constant memory) → `pdf-parse` per page → `RecursiveCharacterTextSplitter`
(1000 chars / 150 overlap) → batch embeddings (64 per call) → `bulkWrite` upserts with deterministic `_id`
(idempotent re-processing) → document READY → invalidate the semantic cache. Failures are recorded on the job and
the offset is committed, so one bad file never blocks a partition.

## Trade-offs worth discussing in interviews
- **Regex guardrails vs LLM classifiers**: regex is ~0 ms, deterministic and auditable but bypassable; production adds an
  LLM/classifier second layer (e.g. Llama Guard) on top, plus tool-level RBAC so a bypass still can't escalate privileges.
- **Semantic cache threshold**: 0.92 trades hit rate against wrong-answer risk; scoped per role and only for read-only intents,
  and flushed on any write so stale answers don't survive a data change.
- **MemorySaver**: fine for a single API replica; multiple replicas need a shared checkpointer (Mongo/Postgres/Redis).
- **Local cosine fallback** is O(n): fine for demo corpora, swap to Atlas `$vectorSearch` (`MONGO_VECTOR_SEARCH=atlas`) at scale.
- **Kafka over a simple queue**: replayable log, ordering per document key, consumer-group horizontal scaling; scale workers on consumer lag.

## Failure modes
| Failure | Behaviour |
|---|---|
| OpenAI down / no key | Mock LLM keeps the platform usable; with a key, `maxRetries: 2` + 60 s timeout |
| Kafka down at upload | Upload fails fast (5xx); nothing half-published. API retries the connection on boot |
| Worker crash mid-document | Offset not committed → message redelivered → idempotent upserts |
| Redis down | `/ready` reports degraded; chat returns 500 (cache lookup fails). `SEMANTIC_CACHE_ENABLED=false` bypasses the cache |
| Scanned PDF (no text) | Job marked FAILED with a clear reason (OCR not enabled) |

## 22-day plan → code
| Day | Item | Implemented in |
|---|---|---|
| 1 | TS repo + Compose (Kafka, Redis, Mongo) | `apps/*`, `docker-compose.yml` |
| 2 | AgentState annotations, channels, intent | `agent/state.ts`, `agent/intent.ts` |
| 3 | Zod tool bindings (`create_tender_db`, …) | `agent/tools.ts` |
| 4 | Supervisor router + conditional `execute_tools` | `agent/graph.ts` |
| 5 | Prompt-injection middleware | `lib/guardrails.ts`, `middleware/guardrails.ts` |
| 6 | PII scrubbing before egress | `lib/pii.ts`, `agent/graph.ts` |
| 7 | JWT + RBAC (BUYER vs SUPPLIER) | `auth/jwt.ts`, `middleware/auth.ts`, `agent/tools.ts` |
| 8 | Kafka producer gateway → 202 | `routes/documents.ts`, `services/kafka.ts` |
| 9 | S3 streaming worker | `worker/src/extract.ts` |
| 10 | Overlapping chunker + batch embeddings | `worker/src/chunker.ts`, `worker/src/index.ts` |
| 11 | Mongo vector upsert | `worker/src/index.ts`, `services/retriever.ts` |
| 12 | Redis HNSW vector index, cosine | `services/semanticCache.ts` |
| 13 | Semantic cache interceptor (≥ 0.92) | `routes/chat.ts` |
| 14 | Write-through + invalidation | `routes/chat.ts`, worker cache flush |
| 15 | Multi-stage Alpine Dockerfiles | `apps/*/Dockerfile` |
| 16 | Compose orchestration + health checks | `docker-compose.yml` |
| 17 | ECS Fargate + ECR + ALB | `infra/aws/` |
| 18 | LangSmith tracing (run names, tags, metadata) | `agent/runner.ts`, env `LANGSMITH_*` |
| 19–20 | Live demo scripts 1–3 | `scripts/demo.mjs` |
