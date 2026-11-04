/**
 * Real-time PII scrubbing applied before any text leaves for the LLM provider.
 * Regex based on purpose: deterministic, fast (<1ms) and auditable.
 */
export interface PiiFinding {
  type: string;
  count: number;
}

const PATTERNS: Array<{ type: string; re: RegExp; replacement: string }> = [
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '[EMAIL_REDACTED]' },
  { type: 'CREDIT_CARD', re: /\b(?:\d[ -]?){13,16}\b/g, replacement: '[CARD_REDACTED]' },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, replacement: '[IBAN_REDACTED]' },
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN_REDACTED]' },
  {
    type: 'PHONE',
    re: /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g,
    replacement: '[PHONE_REDACTED]',
  },
];

export function scrubPii(text: string): { text: string; findings: PiiFinding[] } {
  const findings: PiiFinding[] = [];
  let out = text;
  for (const { type, re, replacement } of PATTERNS) {
    let count = 0;
    out = out.replace(re, (match) => {
      // Do not treat business identifiers / years / amounts as phone numbers.
      if (type === 'PHONE' && match.replace(/\D/g, '').length < 9) return match;
      count++;
      return replacement;
    });
    if (count) findings.push({ type, count });
  }
  return { text: out, findings };
}
