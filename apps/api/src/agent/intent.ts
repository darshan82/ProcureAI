import type { Intent } from './state.js';

/** Fast deterministic intent classifier (no LLM call). Drives caching + routing hints. */
export function classifyIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(create|open|publish|launch|new)\b.{0,30}\btender\b/.test(t)) return 'tender_mutation';
  if (/\b(award|submit|place)\b.{0,30}\b(bid|tender|contract|proposal)?/.test(t) && /\b(bid|award)\b/.test(t)) return 'bid_action';
  if (/\b(document|contract|pdf|clause|policy|uploaded|file|summari[sz]e|terms|penalt|warranty|sla)\b/.test(t)) return 'document_qa';
  if (/\b(tender|tenders|rfp|rfq|bids?|budget|deadline|criteria)\b/.test(t)) return 'tender_query';
  return 'general';
}

export const CACHEABLE_INTENTS: Intent[] = ['tender_query', 'document_qa', 'general'];
