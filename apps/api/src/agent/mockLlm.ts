/**
 * Deterministic stand-in for the LLM, used when OPENAI_API_KEY is not set.
 * It emits real LangChain AIMessages with tool_calls, so the LangGraph graph, ToolNode,
 * RBAC, HITL interrupts, Kafka/RAG and caching all run exactly as they do with OpenAI.
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { UserContext } from './state.js';

let seq = 0;
const callId = () => `call_mock_${Date.now().toString(36)}_${seq++}`;
const toolCall = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: '', tool_calls: [{ id: callId(), name, args, type: 'tool_call' }] });

const TENDER_RE = /\bTND-[A-Z0-9]+\b/i;
const BID_RE = /\bBID-[A-Z0-9]+\b/i;

function parseAmount(text: string): number | undefined {
  const m = text.match(/(?:\$|usd\s*|budget(?: of)?\s*|for\s*|amount(?: of)?\s*|price(?: of)?\s*)([\d][\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/i)
    ?? text.match(/\b([\d][\d,]{3,}(?:\.\d+)?)\s*(k|m)?\b/i);
  if (!m) return undefined;
  let n = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'k' || unit === 'thousand') n *= 1_000;
  if (unit === 'm' || unit === 'million') n *= 1_000_000;
  return n > 0 ? n : undefined;
}

function parseDeadline(text: string): string {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const days = text.match(/\b(\d{1,3})\s*days?\b/i);
  const d = new Date(Date.now() + (days ? Number(days[1]) : 30) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function parseTitle(text: string): string {
  const quoted = text.match(/["“']([^"”']{3,140})["”']/);
  if (quoted) return quoted[1].trim();
  const forClause = text.match(/tender\s+(?:for|to procure|to buy)\s+(.+?)(?:\s+with\b|\s+budget\b|,|\.|\s+due\b|\s+deadline\b|$)/i);
  return (forClause?.[1] ?? 'New procurement request').trim().replace(/^\w/, (c) => c.toUpperCase());
}

function route(text: string, user: UserContext): AIMessage {
  const t = text.toLowerCase();
  const tender = text.match(TENDER_RE)?.[0]?.toUpperCase();
  const bid = text.match(BID_RE)?.[0]?.toUpperCase();

  if (/\b(create|open|publish|launch|new)\b.{0,30}\btender\b/.test(t)) {
    if (user.role !== 'BUYER') return new AIMessage(`Creating tenders is restricted to the BUYER role. You are signed in as ${user.role}.`);
    const budget = parseAmount(text) ?? 50_000;
    return toolCall('create_tender_db', {
      title: parseTitle(text), description: text.slice(0, 500), category: 'General', budget, currency: 'USD',
      deadline: parseDeadline(text), criteria: ['Price (40%)', 'Quality & compliance (30%)', 'Delivery time (20%)', 'Sustainability (10%)'],
    });
  }
  if (/\baward\b/.test(t)) {
    if (user.role !== 'BUYER') return new AIMessage(`Awarding tenders is restricted to the BUYER role. You are signed in as ${user.role}.`);
    if (!tender || !bid) return new AIMessage('To award a tender I need both the tender ID (e.g. TND-1003) and the winning bid ID (e.g. BID-A1B2C3).');
    return toolCall('award_tender', { tenderId: tender, bidId: bid });
  }
  if (/\b(submit|place|send)\b.{0,20}\bbid\b|\bbid\b.{0,20}\b(on|for)\b/.test(t) && user.role === 'SUPPLIER') {
    const amount = parseAmount(text.replace(TENDER_RE, ''));
    if (!tender || !amount) return new AIMessage('To submit a bid please include the tender ID (e.g. TND-1001) and your price (e.g. $165,000).');
    const days = text.match(/\b(\d{1,3})\s*days?\b/i);
    return toolCall('submit_bid', { tenderId: tender, amount, proposal: text.slice(0, 1000), deliveryDays: days ? Number(days[1]) : 30 });
  }
  if (/\bbids?\b/.test(t) && tender) {
    if (user.role !== 'BUYER') return new AIMessage('Viewing competing bids is restricted to the BUYER role.');
    return toolCall('list_bids', { tenderId: tender });
  }
  if (tender) return toolCall('get_tender', { tenderId: tender });
  if (/\b(summar\w*|overview|key terms|risks?|risky|obligations)\b/.test(t) && /\b(contract|agreement|document|uploaded|terms)\b/.test(t)) {
    return toolCall('get_contract_terms', {});
  }
  if (/\b(document|contract|pdf|clause|policy|uploaded|file|summari[sz]e|terms|penalt|warranty|sla|rfp)\b/.test(t)) {
    return toolCall('search_documents', { query: text, k: 4 });
  }
  if (/\b(tender|tenders|rfq|procurement|budget|deadline|criteria)\b/.test(t)) {
    const status = /\bopen\b/.test(t) ? 'OPEN' : /\bevaluation\b/.test(t) ? 'EVALUATION' : /\bawarded\b/.test(t) ? 'AWARDED' : undefined;
    const topic = t.match(/\b(?:about|for|related to|regarding|involving)\s+([a-z][a-z-]{2,30})/)?.[1];
    const args: Record<string, unknown> = {};
    if (status) args.status = status;
    if (topic && !['the', 'any', 'all', 'my', 'our', 'tender', 'tenders'].includes(topic)) args.query = topic.replace(/s$/, '');
    return toolCall('search_tenders', args);
  }
  return new AIMessage(
    `Hi ${user.name}! I'm ProcureAI (running in offline mock-LLM mode). As a ${user.role} you can ask me to:\n` +
      (user.role === 'BUYER'
        ? '- "Show open tenders"\n- "Create a tender for \\"Office chairs\\" with budget $20k due in 21 days"\n- "List bids for TND-1003"\n- "Award TND-1003 to BID-A1B2C3" (needs your approval)\n'
        : '- "Show open tenders"\n- "Submit a bid on TND-1001 for $165,000 with delivery in 20 days"\n') +
      '- "Summarise the uploaded contract" / "What are the penalty clauses?"',
  );
}

const fmtMoney = (n: number, c = 'USD') => `${c} ${Number(n).toLocaleString('en-US')}`;

const STOP = new Set('the a an of to and or in on for with what which who how does do is are be by at this that contract document'.split(' '));
const terms = (q: string) => q.toLowerCase().replace(/[^a-z0-9%\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, ''));

/** Query-focused extractive snippet: the passage's sentences that best overlap the question. */
function bestSentences(text: string, question: string, max = 2): string {
  const q = new Set(terms(question));
  const sentences = text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((x) => x.length > 20);
  const scored = sentences.map((sentence, i) => ({ sentence, i, score: terms(sentence).filter((w) => q.has(w)).length }));
  const top = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i);
  return (top.length ? top.map((x) => x.sentence) : sentences.slice(0, 1)).join(' ').replace(/^(\d+)\.\s/, '$1\\. ').slice(0, 420);
}

function compose(results: ToolMessage[], question = ''): string {
  const parts: string[] = [];
  for (const r of results) {
    const raw = String(r.content);
    if (raw.startsWith('REJECTED')) {
      parts.push(`The action was **not executed**: ${raw.replace(/^REJECTED:\s*/, '')}`);
      continue;
    }
    if (/^Error|FORBIDDEN/i.test(raw)) {
      parts.push(`I couldn't complete that: ${raw.replace(/^Error:\s*/, '')}`);
      continue;
    }
    let d: any;
    try { d = JSON.parse(raw); } catch { parts.push(raw); continue; }
    if (d.error) { parts.push(`⚠️ ${d.error}`); continue; }
    switch (r.name) {
      case 'search_tenders':
        parts.push(d.count === 0 ? 'No tenders matched.' : `Found **${d.count}** tender(s):\n` +
          d.tenders.map((x: any) => `- **${x.tenderId}** · ${x.title} · ${fmtMoney(x.budget, x.currency)} · ${x.status} · due ${x.deadline}`).join('\n'));
        break;
      case 'get_tender':
        parts.push(`**${d.tenderId} - ${d.title}** (${d.status})\n${d.description}\n- Budget: ${fmtMoney(d.budget, d.currency)}\n- Deadline: ${d.deadline}\n- Evaluation criteria: ${d.criteria.join(', ')}`);
        break;
      case 'create_tender_db':
        parts.push(`✅ Tender **${d.tender.tenderId}** "${d.tender.title}" is now OPEN with a budget of ${fmtMoney(d.tender.budget)} and deadline ${d.tender.deadline}.\nCriteria: ${d.tender.criteria.join(', ')}`);
        break;
      case 'submit_bid':
        parts.push(`✅ Bid **${d.bid.bidId}** submitted on ${d.bid.tenderId} for ${fmtMoney(d.bid.amount)} (${d.bid.deliveryDays} days delivery).` +
          (d.withinBudget ? '' : '\n⚠️ Your price is above the tender budget, which may lower your score.'));
        break;
      case 'list_bids':
        parts.push(d.count === 0 ? `No bids yet for ${d.tenderId}.` : `**${d.count}** bid(s) for ${d.tenderId} (cheapest first):\n` +
          d.bids.map((b: any) => `- **${b.bidId}** · ${b.supplier} · ${fmtMoney(b.amount)} · ${b.deliveryDays} days · ${b.status}\n  _${b.proposal}_`).join('\n'));
        break;
      case 'award_tender':
        parts.push(`🏆 ${d.tenderId} awarded to **${d.bidId}** (${d.supplier}) for ${fmtMoney(d.amount)}. Other bids were marked REJECTED and the decision is in the audit log.`);
        break;
      case 'get_contract_terms': {
        const x = d.extraction ?? {};
        const lines = [`**Contract summary: ${x.title ?? d.filename}** (${d.documentId}, extracted by ${x.method ?? 'n/a'})`];
        if (x.parties?.length) lines.push(`- **Parties:** ${x.parties.join(' · ')}`);
        if (x.deliveryDays != null) lines.push(`- **Delivery:** within ${x.deliveryDays} days`);
        if (x.paymentTerms) lines.push(`- **Payment:** ${x.paymentTerms}`);
        if (x.warranty) lines.push(`- **Warranty:** ${x.warranty}`);
        if (x.slaResponse) lines.push(`- **Support SLA:** ${x.slaResponse}`);
        for (const p of x.penalties ?? []) lines.push(`- **Penalty:** ${p}`);
        if (x.terminationNotice) lines.push(`- **Termination:** ${x.terminationNotice}`);
        if (x.evaluationCriteria?.length) lines.push(`- **Evaluation criteria:** ${x.evaluationCriteria.map((c: any) => `${c.criterion} ${c.weight}%`).join(', ')}`);
        if (x.risks?.length) lines.push(`\n**Risk flags**\n${x.risks.map((r: any) => `- ${r.severity.toUpperCase()}: ${r.description}`).join('\n')}`);
        parts.push(lines.join('\n'));
        break;
      }
      case 'search_documents':
        if (!d.count) { parts.push(d.note); break; }
        parts.push(`Here is what the documents say (top ${d.count} passages):\n` +
          d.passages.map((p: any) => `- ${bestSentences(p.text, question)} [${p.source}]`).join('\n') +
          '\n\n_Offline mode quotes the most relevant sentences; add an OpenAI key for a written answer._');
        break;
      default:
        parts.push(raw);
    }
  }
  return parts.join('\n\n');
}

export function mockSupervisor(messages: BaseMessage[], user: UserContext): AIMessage {
  const trailingTools: ToolMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i] instanceof ToolMessage; i--) trailingTools.unshift(messages[i] as ToolMessage);
  const lastHuman = [...messages].reverse().find((m) => m instanceof HumanMessage);
  if (trailingTools.length) return new AIMessage(compose(trailingTools, String(lastHuman?.content ?? '')));
  return route(String(lastHuman?.content ?? ''), user);
}
