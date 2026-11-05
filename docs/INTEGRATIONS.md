# Integrating with ProcureAI

Two ways customer systems connect: **webhooks** (ProcureAI pushes business events to you) and **MCP**
(your agents pull data and act through ProcureAI's tools).

## 1. Webhooks

Configure per tenant (`apps/api/tenants/<tenant>.json` or the admin API):

```json
{ "id": "wh_acme_erp", "url": "https://erp.acme.com/procureai", "secret": "whsec_...", "events": ["tender.created", "bid.submitted", "tender.awarded", "document.ingested", "approval.requested"] }
```

### Events
| Type | When | `data` |
|---|---|---|
| `tender.created` | a buyer (or the agent) publishes a tender | tender fields |
| `bid.submitted` | a supplier submits a bid | `bidId, tenderId, amount, deliveryDays` |
| `approval.requested` | the agent paused for human approval | `threadId, requestedBy, toolCalls[]` |
| `tender.awarded` | an approved award executed | `tenderId, bidId, supplier, amount, currency` |
| `document.ingested` | a document finished processing | `documentId, filename, chunks, pages, riskFlags, highRisks[]` |

Envelope: `{ "eventId", "type", "tenantId", "occurredAt", "actor", "data" }`. Events for one tenant are ordered (Kafka key = tenant).

### Delivery guarantees
- At-least-once. Use `X-ProcureAI-Delivery` (`<eventId>:<webhookId>`) to de-duplicate.
- 3 attempts with exponential backoff (500 ms, 1 s); 4xx responses other than 429 are not retried.
- After the last attempt the event goes to `procurement.events.dlq` and shows as `DEAD_LETTERED` in the admin console, where it can be replayed.

### Verifying signatures
Header: `X-ProcureAI-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Reject if the timestamp is older than 5 minutes.

Node.js:
```js
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verify(secret, rawBody, header) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

Python:
```python
import hmac, hashlib, time
def verify(secret: str, raw_body: bytes, header: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{parts['t']}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

The local stack includes a mock ERP receiver (`/hooks/mock-erp/:tenant`) that verifies signatures exactly like this.
Set `MOCK_ERP_FAIL_RATE=0.5` to simulate a flaky customer endpoint and watch retries and the DLQ.

## 2. MCP (Model Context Protocol)

`POST /mcp` is a stateless Streamable HTTP MCP server. Authenticate with a normal ProcureAI JWT; tools are filtered by the
user's role and the tenant's enabled tools, and every call is tenant-scoped. `award_tender` is never exposed over MCP, and
tenders above the tenant's approval threshold must be created in the web app, so human approval can't be bypassed.

Get a token:
```bash
curl -s localhost:8080/api/auth/login -H 'content-type: application/json' -d '{"email":"buyer@acme.test","password":"demo123"}'
```

Claude Desktop (`claude_desktop_config.json`), via the `mcp-remote` bridge:
```json
{
  "mcpServers": {
    "procureai": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8080/mcp", "--header", "Authorization: Bearer ${PROCUREAI_TOKEN}"],
      "env": { "PROCUREAI_TOKEN": "<paste token>" }
    }
  }
}
```

Raw JSON-RPC check:
```bash
curl -s localhost:8080/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
