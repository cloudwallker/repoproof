import { homedir } from 'node:os';

const MASK = '[REDACTED]';
const SECRET_NAME = '(?:password|passwd|pwd|token|secret|secret[-_]?access[-_]?key|api[-_]?key|access[-_]?token|session[-_]?token|client[-_]?secret|authorization)';
const SECRET_FLAG = '(?:[A-Za-z0-9]+[-_])*' + SECRET_NAME;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePath(text: string, value: string, replacement: string): string {
  if (!value || value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) return text;
  const normalized = value.replace(/[\\/]+$/, '');
  const pattern = normalized.split(/[\\/]/).map(escapeRegex).join('[\\\\/]');
  return text.replace(new RegExp(pattern + '(?=$|[\\\\/\\s"\'<>:),;])', /^[A-Za-z]:/.test(value) ? 'gi' : 'g'), replacement);
}

/** Best-effort masking for stored output; arbitrary prose secrets remain outside the contract. */
export function redactText(text: string, repoRoot?: string): string {
  let result = String(text);
  if (repoRoot) result = replacePath(result, repoRoot, '<repo>');
  result = replacePath(result, homedir(), '<home>');
  result = result
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, MASK)
    .replace(/(?<![a-z0-9+.-])([0-9+.-]*[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1' + MASK + '@')
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, 'Bearer ' + MASK)
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-|svcacct-)?|xox[baprs]-|AIza|AKIA|ASIA)[A-Za-z0-9_-]+/g, MASK)
    .replace(new RegExp('(?<![A-Za-z0-9_-])(["\']?[A-Za-z0-9_-]*' + SECRET_NAME + '["\']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"?|\'[^\'\\r\\n]*\'?|[^\\s,;}]+)', 'gi'), '$1' + MASK)
    .replace(new RegExp('(--?' + SECRET_FLAG + '\\s+)(?:"[^"\\r\\n]*"?|\'[^\'\\r\\n]*\'?|[^\\s,;}]+)', 'gi'), '$1' + MASK)
    .replace(/(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/gi, '<email>')
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/gi, '<home>')
    .replace(/\/(?:home|Users)\/[^/\s"'<>]+/g, '<home>');
  return result;
}

export function redactCommand(command: string[], repoRoot?: string): string[] {
  let redactNext = false;
  const flag = new RegExp('^--?' + SECRET_FLAG + '$', 'i');
  const inlineFlag = new RegExp('^(--?' + SECRET_FLAG + '=)', 'i');
  return command.map((argument) => {
    const inline = argument.match(inlineFlag);
    const result = redactNext ? MASK : inline ? inline[1] + MASK : redactText(argument, repoRoot);
    redactNext = flag.test(argument);
    return result;
  });
}
