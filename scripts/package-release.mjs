// Package the already-built and smoke-checked production runtime only.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deterministicArchive, filesUnder, thirdPartyLicenses } from './archive-utils.mjs';
import { parseBrowserArgs } from './browser-target.mjs';

const { target } = parseBrowserArgs(process.argv.slice(2));
const root = resolve('.');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const slug = `us-visa-scheduler-for-canada-${pkg.version}${target.artifactSuffix}`;
const dist = join(root, target.outDir);
execFileSync(process.execPath, [join(root, 'scripts/release-smoke.mjs'), '--browser', target.name, dist], { stdio: 'inherit' });
const release = join(root, 'release');
mkdirSync(release, { recursive: true });
const generated = {
  LICENSE: readFileSync(join(root, 'LICENSE')),
  'THIRD_PARTY_LICENSES.txt': thirdPartyLicenses(root),
  'SOURCE.txt': `US Visa Scheduler for Canada ${pkg.version}\nLicense: GPL-3.0-only; see LICENSE.\nCorresponding Source: https://github.com/Tsahao/usvisa-ca-extension/tree/v${pkg.version}\nSource ZIP: https://github.com/Tsahao/usvisa-ca-extension/archive/refs/tags/v${pkg.version}.zip\nBuild instructions: README.md in the source archive.\nRequires Node.js 22.12+ on a supported Node release: npm ci && npm run check.\nOptional production analytics configuration is documented in .env.example;\nprivate build configuration is never included in the source archive.\nRelease publishers must verify that the published tag matches all runtime\nsource files before distributing this ZIP.\n`,
};
const output = join(release, `${slug}.zip`);
const digest = deterministicArchive(dist, filesUnder(dist), generated, output);
console.log(`package-release OK: ${output}\nsha256: ${digest}`);
