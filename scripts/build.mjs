import { stripTypeScriptTypes } from 'node:module';
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Read string literals as tokens, so example strings and comments are never
// mistaken for module specifiers. Type erasure happens before this scan.
function rewriteImports(source) {
  const tokens = [];
  let i = 0;
  const scan = (templateExpression = false) => {
    const parens = [];
    const braces = [];
    let regexAllowed = true;
    while (i < source.length) {
      const start = i;
      const char = source[i];
      const previous = tokens.at(-1);
      if (/\s/.test(char)) { i++; continue; }
      if (source.startsWith('//', i)) { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
      if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (char === '/' && regexAllowed) {
        i++;
        let inClass = false;
        while (i < source.length) {
          const current = source[i++];
          if (current === '\\') { i++; continue; }
          if (current === '[') inClass = true;
          if (current === ']') inClass = false;
          if (current === '/' && !inClass) break;
        }
        while (i < source.length && /[A-Za-z]/.test(source[i])) i++;
        tokens.push({ start, end: i, value: source.slice(start, i), kind: 'regex' });
        regexAllowed = false;
        continue;
      }
      if (char === '`') {
        i++;
        tokens.push({ start, end: i, value: '`', kind: 'template' });
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '`') { i++; break; }
          if (source.startsWith('${', i)) { i += 2; scan(true); continue; }
          i++;
        }
        tokens.push({ start: i - 1, end: i, value: '`', kind: 'template' });
        regexAllowed = false;
        continue;
      }
      if (char === '"' || char === "'") {
        i++;
        while (i < source.length) { if (source[i] === '\\') { i += 2; continue; } if (source[i++] === char) break; }
        tokens.push({ start, end: i, value: source.slice(start + 1, i - 1), kind: 'string' });
        regexAllowed = false;
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        i++; while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
        const value = source.slice(start, i);
        tokens.push({ start, end: i, value, kind: 'word' });
        regexAllowed = ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'yield', 'await', 'in', 'instanceof', 'of', 'else', 'do', 'break', 'continue', 'debugger'].includes(value);
        continue;
      }
      if (/\d/.test(char)) {
        i++; while (i < source.length && /[\w.]/.test(source[i])) i++;
        tokens.push({ start, end: i, value: source.slice(start, i), kind: 'number' });
        regexAllowed = false;
        continue;
      }
      if (char === '}' && templateExpression && braces.length === 0) { i++; return; }
      const pair = source.slice(i, i + 2);
      const value = ['=>', '++', '--', '?.'].includes(pair) ? pair : char;
      i += value.length;
      if (value === '(') {
        parens.push(previous?.kind === 'word' && ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(previous.value));
        regexAllowed = true;
      } else if (value === ')') regexAllowed = Boolean(parens.pop());
      else if (value === '{') {
        const block = !previous || [';', ')', '=>', 'else', 'do', 'try', 'finally'].includes(previous.value);
        braces.push(block);
        regexAllowed = true;
      } else if (value === '}') regexAllowed = Boolean(braces.pop());
      else if (![ '++', '--' ].includes(value)) regexAllowed = ![']', '.', '?.'].includes(value);
      tokens.push({ start, end: i, value, kind: 'punct' });
    }
  };
  scan();
  const replacements = new Map();
  const rewrite = (token) => {
    if (token?.kind === 'string' && /^\.{1,2}\//.test(token.value) && token.value.endsWith('.ts')) {
      replacements.set(token.start, { ...token, value: source.slice(token.start, token.end - 4) + '.js' + source[token.end - 1] });
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'word' || !['import', 'export'].includes(token.value) || tokens[i - 1]?.value === '.') continue;
    if (token.value === 'import' && tokens[i + 1]?.value === '(') { rewrite(tokens[i + 2]); continue; }
    if (token.value === 'import' && tokens[i + 1]?.kind === 'string') { rewrite(tokens[i + 1]); continue; }
    // Static module imports/exports may span lines; stop at the declaration end.
    for (let j = i + 1; j < tokens.length && tokens[j].value !== ';'; j++) {
      if (tokens[j].kind === 'word' && tokens[j].value === 'from') { rewrite(tokens[j + 1]); break; }
      if (tokens[j].value === '=') break;
    }
  }
  let result = source;
  for (const token of [...replacements.values()].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, token.start) + token.value + result.slice(token.end);
  }
  return result;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
for (const name of (await readdir(join(root, 'src'))).filter((name) => name.endsWith('.ts')).sort()) {
  const source = await readFile(join(root, 'src', name), 'utf8');
  const output = join(dist, name.slice(0, -3) + '.js');
  await writeFile(output, rewriteImports(stripTypeScriptTypes(source, { mode: 'strip' })));
  execFileSync(process.execPath, ['--check', output], { stdio: 'pipe', windowsHide: true });
}
