// Vite copies `public/` verbatim into the build output, so macOS Finder
// metadata (`.DS_Store`) parked there would otherwise land in `dist/` and fail
// the release smoke allowlist.
//
// Deliberately narrow: only that one Finder artifact is removed. Every other
// unexpected runtime file still fails `scripts/release-smoke.mjs` loudly
// instead of being silently normalized away.
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const FINDER_METADATA = '.DS_Store';

export function removeFinderMetadata(root, relative = '') {
  const full = join(root, relative);
  if (!existsSync(full)) return [];
  const removed = [];
  for (const name of readdirSync(full)) {
    const child = relative ? `${relative}/${name}` : name;
    if (name === FINDER_METADATA) {
      rmSync(join(root, child), { recursive: true, force: true });
      removed.push(child);
    } else if (lstatSync(join(root, child)).isDirectory()) {
      removed.push(...removeFinderMetadata(root, child));
    }
  }
  return removed;
}
