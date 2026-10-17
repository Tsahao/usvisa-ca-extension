import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolveBrowserTarget } from './scripts/browser-target.mjs';

export default defineConfig(({ mode }) => {
  const target = resolveBrowserTarget(process.env.BROWSER_TARGET);
  // Release (production mode) ships only the product pages. The development
  // probe page and its worker-mutation controls stay available to the dev
  // server and test/fixture builds, whose packaged suites rely on them.
  const includeProbe = mode !== 'production';
  const input: Record<string, string> = includeProbe
    ? { background: 'src/background.ts', probe: 'probe.html', panel: 'panel.html' }
    : { background: 'src/background.ts', panel: 'panel.html' };
  return {
    base: './',
    plugins: [{
      name: 'browser-manifest',
      generateBundle() {
        const manifest = JSON.parse(readFileSync(new URL(`./${target.manifestPath}`, import.meta.url), 'utf8'));
        // The legacy iframe is a developer fixture, not a public product surface.
        if (!includeProbe) delete manifest.web_accessible_resources;
        // Analytics uses ordinary CORS fetch, not privileged host access.
        this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) + '\n' });
      },
    }],
    build: {
      outDir: target.outDir,
      rollupOptions: {
        input,
        output: { entryFileNames: '[name].js' },
      },
    },
  };
});
