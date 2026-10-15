import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceInventory } from './package-source.mjs';
import { deterministicArchive } from './archive-utils.mjs';
import { publicInventory } from './prepare-public.mjs';
import { renderPolicy } from './build-privacy.mjs';

test('privacy site refuses unfinished inputs and escapes HTML without adding remote resources', () => {
  assert.throws(() => renderPolicy('# Privacy (draft)\n\n[OWNER INPUT: contact]'), /unfinished/);
  const html = renderPolicy('# Privacy Policy\n\n<script>alert(1)</script>\n\n- **Local storage:** stays local.\n\n[Contact](mailto:privacy@example.invalid)');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>Local storage:</strong>'));
  assert.ok(html.includes('href="mailto:privacy@example.invalid"'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('src="https://'));
});

test('public checkout retains complete build sources and synthetic tests but excludes working notes and Git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'usvisa-public-test-'));
  try {
    for (const file of ['src/new.ts', 'tests/new.test.ts', 'scripts/build.mjs',
      'public/icons/test.png', 'docs/privacy-policy.md', 'docs/privacy-policy.html',
      'docs/.nojekyll', 'docs/implementation-plan.md', 'docs/private-review.md',
      'AGENTS.md', '.env.local', '.env.example', '.git/config', 'README.md']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'synthetic');
    }
    assert.deepEqual(publicInventory(root), [
      '.env.example', 'README.md', 'docs/.nojekyll', 'docs/privacy-policy.html',
      'docs/privacy-policy.md', 'public/icons/test.png', 'scripts/build.mjs',
      'src/new.ts', 'tests/new.test.ts',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source allowlist omits arbitrary root private files, includes untracked source, rejects nested secrets/symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'usvisa-package-test-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/new.ts'), 'export const synthetic = true;');
    for (const name of ['.env.production', '.env.local', 'private-account.json', 'dump.html']) writeFileSync(join(root, name), 'synthetic-private');
    writeFileSync(join(root, '.env.example'), 'SYNTHETIC_CONFIG=');
    assert.deepEqual(sourceInventory(root), ['.env.example', 'src/new.ts']);
    writeFileSync(join(root, 'src/.env.production'), 'synthetic-private');
    assert.throws(() => sourceInventory(root), /environment file/);
    rmSync(join(root, 'src/.env.production'));
    writeFileSync(join(root, 'src/private.key'), 'synthetic-private');
    assert.throws(() => sourceInventory(root), /sensitive/);
    rmSync(join(root, 'src/private.key'));
    symlinkSync(join(root, 'private-account.json'), join(root, 'src/link.ts'));
    assert.throws(() => sourceInventory(root), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive bytes are deterministic despite source mtimes and input order; generated notices do not mutate source', () => {
  const root = mkdtempSync(join(tmpdir(), 'usvisa-package-test-'));
  try {
    writeFileSync(join(root, 'b.txt'), 'b');
    writeFileSync(join(root, 'a.txt'), 'a');
    const first = join(root, 'first.zip'); const second = join(root, 'second.zip');
    const one = deterministicArchive(root, ['b.txt', 'a.txt'], { 'SOURCE.txt': 'synthetic snapshot' }, first);
    utimesSync(join(root, 'a.txt'), new Date(), new Date());
    const two = deterministicArchive(root, ['a.txt', 'b.txt'], { 'SOURCE.txt': 'synthetic snapshot' }, second);
    assert.equal(one, two);
    assert.deepEqual(readFileSync(first), readFileSync(second));
    assert.equal(execFileSync('unzip', ['-p', first, 'SOURCE.txt'], { encoding: 'utf8' }), 'synthetic snapshot');
    assert.equal(execFileSync('unzip', ['-Z1', first], { encoding: 'utf8' }), 'SOURCE.txt\na.txt\nb.txt\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
