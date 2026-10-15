// Package the already-built and smoke-checked production runtime only.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deterministicArchive, filesUnder, thirdPartyLicenses } from './archive-utils.mjs';

const root = resolve('.');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const slug = `us-visa-scheduler-for-canada-${pkg.version}`;
const dist = join(root, 'dist');
execFileSync(process.execPath, [join(root, 'scripts/release-smoke.mjs'), dist], { stdio: 'inherit' });
const release = join(root, 'release');
mkdirSync(release, { recursive: true });
const generated = {
  LICENSE: readFileSync(join(root, 'LICENSE')),
  'THIRD_PARTY_LICENSES.txt': thirdPartyLicenses(root),
  'SOURCE.txt': `US Visa Scheduler for Canada ${pkg.version}\nLicense: GPL-3.0-only; see LICENSE.\nCorresponding Source snapshot: ${slug}-source.zip.\nPublisher action required: host that exact source archive publicly and provide\nclear download directions alongside every binary distribution. The Web Store\ndoes not automatically serve the source archive. A dirty working-tree snapshot\ncannot be reproduced from HEAD alone. Source build instructions are inside\nSOURCE_VERSION.txt in the source archive.\n`,
};
const output = join(release, `${slug}.zip`);
const digest = deterministicArchive(dist, filesUnder(dist), generated, output);
console.log(`package-release OK: ${output}\nsha256: ${digest}`);
