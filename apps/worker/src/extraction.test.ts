import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessRisks, heuristicExtract } from './extraction.js';

test('heuristic extraction pulls key terms from the sample contract', async () => {
  const text = await readFile(new URL('../../../samples/sample-contract.md', import.meta.url), 'utf8');
  const t = heuristicExtract(text, 'sample-contract.md');
  assert.match(t.title, /Master Supply Agreement/);
  assert.deepEqual(t.parties, ['ACME Corp', 'the selected supplier']);
  assert.equal(t.deliveryDays, 30);
  assert.match(t.paymentTerms ?? '', /Net 45 days/);
  assert.match(t.warranty ?? '', /3-year on-site warranty/);
  assert.match(t.slaResponse ?? '', /4 business hours/);
  assert.ok(t.penalties.some((p) => /0\.5%/.test(p)));
  assert.equal(t.evaluationCriteria.reduce((n, c) => n + c.weight, 0), 100);
  const risks = assessRisks(t, text);
  assert.ok(risks.some((r) => r.severity === 'high' && /limitation-of-liability/.test(r.description)));
  assert.ok(risks.some((r) => /terminate for convenience/.test(r.description)));
});
