// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'release-files.json'), 'utf8'));
const allowed = new Set(manifest.files);
const errors = [];
function files(dir) {
  return readdirSync(dir).flatMap(name => {
    if (['.git', 'node_modules', 'dist', 'coverage'].includes(name) || name.endsWith('.tgz')) return [];
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) { errors.push(`Symlink is not allowed: ${relative(root, full)}`); return []; }
    return stat.isDirectory() ? files(full) : [relative(root, full).split(sep).join('/')];
  });
}
const actual = files(root);
for (const file of actual) if (!allowed.has(file)) errors.push(`Outside reviewed release manifest: ${file}`);
for (const file of allowed) if (!actual.includes(file)) errors.push(`Missing release file: ${file}`);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
];
for (const file of actual) {
  const content = readFileSync(join(root, file), 'utf8');
  if (secretPatterns.some(pattern => pattern.test(content))) errors.push(`Potential credential in ${file} (value redacted)`);
  if (!file.startsWith('src/') || !file.endsWith('.ts')) continue;
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  function check(specifier) {
    if (specifier.startsWith('.')) {
      const full = resolve(dirname(join(root, file)), specifier.replace(/\.js$/, '.ts'));
      const rel = relative(root, full).split(sep).join('/');
      if (!rel.startsWith('src/') || !allowed.has(rel) || !existsSync(full)) errors.push(`Non-Core import in ${file}: ${specifier}`);
    } else if (!specifier.startsWith('node:') && !['typescript', 'yaml'].includes(specifier)) errors.push(`Unapproved dependency in ${file}: ${specifier}`);
  }
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) errors.push(`Nonliteral import in ${file}`); else check(argument.text);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Release boundary passed: ${actual.length} reviewed files, closed Core imports, no recognized credential patterns. This is not a comprehensive secret or security audit.`);
