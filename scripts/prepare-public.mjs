// Produce a new public checkout without carrying private development history.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceInventory } from './package-source.mjs';
import { thirdPartyLicenses } from './archive-utils.mjs';

export function publicInventory(root) {
  return sourceInventory(root);
}

export function preparePublic(root, output) {
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing public checkout: ${output}`);
  const files = publicInventory(root);
  mkdirSync(output, { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(output, file)), { recursive: true });
    copyFileSync(join(root, file), join(output, file));
  }
  writeFileSync(join(output, 'THIRD_PARTY_LICENSES.txt'), thirdPartyLicenses(root));
  console.log(`prepare-public OK: ${output} (${files.length + 1} files; no Git history)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePublic(resolve('.'), resolve(process.argv[2] || 'release/github-public'));
}
