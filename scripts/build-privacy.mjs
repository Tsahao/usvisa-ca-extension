// Small static renderer for the policy's headings, paragraphs, lists and tables.
// Raw HTML is escaped; the published page runs no JavaScript or third-party code.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderPolicy(markdown) {
  if (/OWNER INPUT|\(draft\)|\/Users\//i.test(markdown)) throw new Error('Privacy policy still contains unfinished publisher inputs.');
  const output = [];
  let paragraph = [], list = false, table = false;
  function flush() {
    if (paragraph.length) { output.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; }
  }
  function closeList() { if (list) { output.push('</ul>'); list = false; } }
  function closeTable() { if (table) { output.push('</tbody></table></div>'); table = false; } }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); closeList(); closeTable(); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush(); closeList(); closeTable();
      output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (line.startsWith('|')) {
      flush(); closeList();
      const cells = line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      if (cells.every(cell => /^:?-+:?$/.test(cell))) continue;
      const tag = table ? 'td' : 'th';
      if (!table) { output.push('<div class="table-scroll"><table><tbody>'); table = true; }
      output.push(`<tr>${cells.map(cell => `<${tag}>${inline(cell)}</${tag}>`).join('')}</tr>`);
    } else if (line.startsWith('- ')) {
      flush(); closeTable();
      if (!list) { output.push('<ul>'); list = true; }
      output.push(`<li>${inline(line.slice(2))}</li>`);
    } else {
      closeList(); closeTable();
      paragraph.push(line);
    }
  }
  flush(); closeList(); closeTable();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Privacy policy for US Visa Scheduler for Canada, including local credential storage, workflow data and limited usage analytics.">
<meta name="referrer" content="no-referrer"><title>Privacy Policy | US Visa Scheduler for Canada</title>
<link rel="stylesheet" href="site.css"></head><body><main>${output.join('\n')}</main></body></html>\n`;
}

export function buildPrivacy(root) {
  const html = renderPolicy(readFileSync(resolve(root, 'docs/privacy-policy.md'), 'utf8'));
  writeFileSync(resolve(root, 'docs/privacy-policy.html'), html);
  writeFileSync(resolve(root, 'docs/index.html'), html);
  writeFileSync(resolve(root, 'docs/.nojekyll'), '');
  console.log('build-privacy OK: docs/index.html and docs/privacy-policy.html');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildPrivacy(resolve('.'));
