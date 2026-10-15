// Corresponding Source: explicit project allowlist, never an entire-tree ZIP.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicArchive, filesUnder, thirdPartyLicenses } from './archive-utils.mjs';

export const sourceRoots = ['src', 'public', 'tests', 'scripts', 'docs'];
export const sourceFiles = ['.env.example', '.gitignore', 'AGENTS.md', 'LICENSE', 'README.md',
  'package.json', 'package-lock.json', 'index.html', 'panel.html', 'probe.html',
  'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts'];

export function sourceInventory(root) {
  const files = [...sourceFiles.filter(file => existsSync(join(root, file))),
    ...sourceRoots.flatMap(dir => existsSync(join(root, dir)) ? filesUnder(root, dir) : [])];
  for (const file of files) {
    const parts = file.split('/');
    if (file !== '.env.example' && parts.some(part => part.startsWith('.env'))) throw new Error(`Source archive refuses environment file: ${file}`);
    if (parts.some(part => /^(?:node_modules|\.git|\.artifacts|release|dist(?:-.*)?|coverage|test-results|playwright-report|private|secrets?|profiles?|dumps?)$/i.test(part)) ||
        /\.(?:pem|key|p12|pfx|crt|cer|har|log|sqlite|db|zip|tsbuildinfo)$/i.test(file) ||
        parts.some(part => /[\r\n]/.test(part))) throw new Error(`Source archive refuses sensitive/output file: ${file}`);
  }
  return files.sort();
}

export function packageSource(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const slug = `us-visa-scheduler-for-canada-${pkg.version}`;
  const release = join(root, 'release');
  mkdirSync(release, { recursive: true });
  const generated = {
    'THIRD_PARTY_LICENSES.txt': thirdPartyLicenses(root),
    'SOURCE_VERSION.txt': `US Visa Scheduler for Canada ${pkg.version} — Corresponding Source snapshot.\nThis archive includes the working-tree source at packaging time, including\nrequired untracked project files; HEAD alone is not its provenance.\nBuild with Node 22.12+ on a supported Node release: npm ci && npm run check.\nLoad dist/ as an unpacked Chrome extension. Production analytics is disabled\nwithout owner-supplied build configuration; .env.example documents optional\nconfiguration. Never publish .env.local or private state.\nBinary: ${slug}.zip. License: GPL-3.0-only, see LICENSE.\nPublisher must host this archive and link it alongside binary distribution.\n`,
  };
  const output = join(release, `${slug}-source.zip`);
  const digest = deterministicArchive(root, sourceInventory(root), generated, output);
  console.log(`package-source OK: ${output}\nsha256: ${digest}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageSource(resolve('.'));
