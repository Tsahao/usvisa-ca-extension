import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseBrowserArgs, resolveBrowserTarget } from '../scripts/browser-target.mjs';

describe('browser target selection', () => {
  it('defaults to Chrome, accepts both CLI forms and preserves other arguments', () => {
    const chrome = resolveBrowserTarget();
    expect(chrome).toEqual({ name: 'chrome', manifestPath: 'public/manifest.json', outDir: 'dist', artifactSuffix: '' });
    expect(parseBrowserArgs([], {})).toEqual({ target: chrome, args: [] });
    expect(parseBrowserArgs(['--browser=chrome', 'custom-dist'], {})).toEqual({ target: chrome, args: ['custom-dist'] });
    expect(parseBrowserArgs(['--mode', 'test', '--browser', 'chrome'], { BROWSER_TARGET: 'safari' }))
      .toEqual({ target: chrome, args: ['--mode', 'test'] });
    expect(() => resolveBrowserTarget('firefox')).toThrow('Unknown browser target');
    expect(() => resolveBrowserTarget('toString')).toThrow('Unknown browser target');
    expect(() => parseBrowserArgs(['--browser'], {})).toThrow('requires a target');
    expect(() => parseBrowserArgs(['--browser='], {})).toThrow('requires a target');
    expect(() => parseBrowserArgs(['--browser', '--mode'], {})).toThrow('requires a target');
    expect(() => parseBrowserArgs(['--browser=chrome', '--browser=chrome'], {})).toThrow('only once');
  });

  it('rejects the placeholder before builds, smoke checks or either packager can touch output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'usvisa-target-refusal-'));
    try {
      for (const script of ['build.mjs', 'release-smoke.mjs', 'package-release.mjs', 'package-source.mjs']) {
        for (const cli of [false, true]) {
          const env = { ...process.env, BROWSER_TARGET: cli ? 'chrome' : 'safari' };
          const result = spawnSync(process.execPath, [resolve('scripts', script), ...(cli ? ['--browser', 'safari'] : [])], { cwd, env, encoding: 'utf8' });
          expect(result.status, script).not.toBe(0);
          expect(result.stderr, script).toContain('is a placeholder; build and packaging are not implemented');
          expect(readdirSync(cwd), script).toEqual([]);
        }
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('keeps default/explicit Chrome bytes and production/test manifest rules', () => {
    const staging = mkdtempSync(join(tmpdir(), 'usvisa-target-build-'));
    try {
      const source = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
      let defaultFiles: Record<string, string> | undefined;
      for (const scenario of [
        { name: 'default', mode: 'production', target: undefined, analytics: false },
        { name: 'explicit', mode: 'production', target: 'chrome', analytics: false },
        { name: 'analytics', mode: 'production', target: 'chrome', analytics: true },
        { name: 'test', mode: 'test', target: 'chrome', analytics: true },
      ]) {
        const outDir = join(staging, scenario.name);
        const env: NodeJS.ProcessEnv = { ...process.env, VITE_POSTHOG_PROJECT_TOKEN: 'phc_SYNTHETICTARGET123',
          VITE_POSTHOG_HOST: 'https://eu.i.posthog.com', VITE_POSTHOG_ENABLED: String(scenario.analytics) };
        delete env.BROWSER_TARGET;
        if (scenario.target) Object.assign(env, { BROWSER_TARGET: scenario.target });
        const result = spawnSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', scenario.mode, '--outDir', outDir], { env, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        const expected = structuredClone(source);
        if (scenario.mode === 'production') delete expected.web_accessible_resources;
        if (scenario.mode !== 'test' && scenario.analytics) expected.host_permissions.push('https://eu.i.posthog.com/*');
        expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).toBe(JSON.stringify(expected, null, 2) + '\n');
        expect(existsSync(join(outDir, 'probe.html'))).toBe(scenario.mode === 'test');
        expect(existsSync(join(outDir, 'probe.js'))).toBe(scenario.mode === 'test');
        if (scenario.name === 'default' || scenario.name === 'explicit') {
          const files = Object.fromEntries(readdirSync(outDir, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile()).map(entry => {
              const path = join(entry.parentPath, entry.name);
              return [path.slice(outDir.length), readFileSync(path).toString('base64')];
            }));
          if (defaultFiles) expect(files).toEqual(defaultFiles);
          else defaultFiles = files;
        }
      }
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }, 30_000);
});
