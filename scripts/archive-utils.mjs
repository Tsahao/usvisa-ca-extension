import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function filesUnder(root, relative = '') {
  const full = join(root, relative);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error(`Archive refuses symlink: ${relative}`);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) throw new Error(`Archive refuses special file: ${relative}`);
  return readdirSync(full).sort().flatMap(name => filesUnder(root, relative ? `${relative}/${name}` : name));
}

export function thirdPartyLicenses(root) {
  // scheduler is bundled transitively by react-dom; lucide's full LICENSE
  // includes its Feather-derived icon notices as well as ISC terms.
  return ['react', 'react-dom', 'scheduler', 'lucide-react'].map(name => {
    const base = join(root, 'node_modules', name);
    const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    return `${name} ${pkg.version}\n${'='.repeat(72)}\n${readFileSync(join(base, 'LICENSE'), 'utf8').trim()}\n`;
  }).join('\n');
}

export function deterministicArchive(root, files, generated, zipPath) {
  // zip -X alone is not reproducible: normalize order, permissions, timezone
  // and timestamps in an isolated staging directory, never in dist/source.
  const staging = mkdtempSync(join(tmpdir(), 'usvisa-release-'));
  const epoch = new Date('2000-01-01T00:00:00Z');
  try {
    const entries = [...new Set([...files, ...Object.keys(generated)])].sort();
    for (const file of entries) {
      if (!file || file.startsWith('/') || file.split('/').some(part => part === '..') || /[\r\n]/.test(file)) throw new Error('Invalid archive path');
      const target = join(staging, file);
      mkdirSync(dirname(target), { recursive: true });
      if (Object.hasOwn(generated, file)) writeFileSync(target, generated[file]);
      else {
        if (!lstatSync(join(root, file)).isFile() || lstatSync(join(root, file)).isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
        copyFileSync(join(root, file), target);
      }
      chmodSync(target, 0o644);
      utimesSync(target, epoch, epoch);
    }
    rmSync(zipPath, { force: true });
    execFileSync('zip', ['-X', '-q', '-9', zipPath, '-@'], {
      cwd: staging, input: entries.join('\n') + '\n', env: { ...process.env, TZ: 'UTC' },
    });
    const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    writeFileSync(`${zipPath}.sha256`, `${digest}  ${zipPath.split('/').at(-1)}\n`);
    return digest;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
