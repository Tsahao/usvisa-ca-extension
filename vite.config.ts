import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { resolveAnalyticsConfig } from './src/analytics/config';
import { resolveBrowserTarget } from './scripts/browser-target.mjs';

export default defineConfig(({ mode }) => {
  const target = resolveBrowserTarget(process.env.BROWSER_TARGET);
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const analytics = resolveAnalyticsConfig({ token: env.VITE_POSTHOG_PROJECT_TOKEN, host: env.VITE_POSTHOG_HOST,
    enabledFlag: mode === 'test' ? 'false' : env.VITE_POSTHOG_ENABLED });
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
      name: 'scoped-posthog-manifest',
      generateBundle() {
        const manifest = JSON.parse(readFileSync(new URL(`./${target.manifestPath}`, import.meta.url), 'utf8'));
        // The legacy iframe is a developer fixture, not a public product surface.
        if (!includeProbe) delete manifest.web_accessible_resources;
        if (analytics.enabled) manifest.host_permissions.push(`${analytics.host}/*`);
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
