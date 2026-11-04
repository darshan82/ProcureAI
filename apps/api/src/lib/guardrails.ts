/**
 * Prompt-injection / jailbreak detection. A layered, cheap first line of defence that runs
 * before the LLM is called. Returns the matched rule so it can be logged and audited.
 */
export interface GuardrailVerdict {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

const RULES: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: 'ignore_instructions', re: /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|system|earlier)\b.{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i, reason: 'Attempt to override system instructions' },
  { id: 'reveal_system_prompt', re: /\b(reveal|show|print|repeat|leak|output|tell me)\b.{0,30}\b(system|hidden|initial|developer)\s+(prompt|instructions?|message)\b/i, reason: 'Attempt to exfiltrate the system prompt' },
  { id: 'role_hijack', re: /\b(you are now|act as|pretend to be|from now on you are)\b.{0,40}\b(dan|jailbroken|unrestricted|admin|root|developer mode|no restrictions)\b/i, reason: 'Role hijacking / jailbreak persona' },
  { id: 'developer_mode', re: /\b(developer|god|sudo|jailbreak)\s+mode\b/i, reason: 'Jailbreak mode request' },
  { id: 'privilege_escalation', re: /\b(set|change|switch|make)\b.{0,20}\b(my|the)?\s*role\b.{0,20}\b(to|as)\b.{0,10}\b(buyer|admin|supplier)\b/i, reason: 'Attempt to escalate role via prompt' },
  { id: 'fake_system_tag', re: /<\s*\/?\s*(system|assistant|im_start|im_end)\s*>|\[\s*system\s*\]|###\s*system/i, reason: 'Injected chat-template / system tags' },
  { id: 'tool_abuse', re: /\b(call|invoke|run|execute)\b.{0,20}\b(award_tender|create_tender_db|submit_bid)\b.{0,40}\b(without|skip|bypass)\b.{0,20}\b(approval|review|check)/i, reason: 'Attempt to bypass human approval' },
  { id: 'data_exfiltration', re: /\b(dump|export|list)\b.{0,20}\b(all)\b.{0,20}\b(users?|passwords?|secrets?|api[_ ]?keys?|tokens?|credentials?)\b/i, reason: 'Credential / bulk data exfiltration attempt' },
  { id: 'encoded_payload', re: /(?:[A-Za-z0-9+/]{120,}={0,2})/, reason: 'Long encoded payload (possible smuggled instructions)' },
];

export const MAX_PROMPT_CHARS = 4000;

export function checkPrompt(input: string): GuardrailVerdict {
  if (!input || !input.trim()) return { allowed: false, rule: 'empty', reason: 'Empty message' };
  if (input.length > MAX_PROMPT_CHARS) {
    return { allowed: false, rule: 'max_length', reason: `Message exceeds ${MAX_PROMPT_CHARS} characters` };
  }
  // Normalise common obfuscations: zero-width chars and excessive spacing.
  const normalised = input.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ');
  for (const rule of RULES) {
    if (rule.re.test(normalised)) return { allowed: false, rule: rule.id, reason: rule.reason };
  }
  return { allowed: true };
}
