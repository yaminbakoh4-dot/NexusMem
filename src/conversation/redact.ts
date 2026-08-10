/**
 * Best-effort secret redaction for conversation text before it is ever
 * written to the FTS index.
 *
 * This is a safety net, not a guarantee -- pattern-based redaction cannot
 * catch every shape a secret can take. It exists because conversation text
 * is the collector most likely to contain something sensitive (a pasted
 * credential, a key a user asked for help debugging), unlike git diffs or
 * shell commands which rarely carry raw secret values verbatim.
 */

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // key/token/secret/password = "value" or : value, in code, JSON, env-file or prose form.
  {
    name: 'key-value-secret',
    pattern: /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)s?)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{8,}['"]?/gi,
  },
];

export interface RedactResult {
  text: string;
  redactedCount: number;
}

export function redact(text: string): RedactResult {
  let redactedCount = 0;
  let out = text;

  for (const rule of RULES) {
    out = out.replace(rule.pattern, (_match: string, ...rest: unknown[]) => {
      redactedCount += 1;
      // `String.replace` passes (match, ...groups, offset, wholeString), so for
      // a rule with no capture group `rest[0]` is the *offset* -- a number, and
      // truthy at any position but the very first. Testing the type rather than
      // truthiness is what keeps a match position out of the indexed corpus.
      const key = typeof rest[0] === 'string' ? rest[0] : null;
      // Keep the key name for key/value matches so the redaction is legible
      // ("apiKey: [redacted]" reads better than a bare "[redacted]").
      return key ? `${key}: [redacted]` : '[redacted]';
    });
  }

  return { text: out, redactedCount };
}
