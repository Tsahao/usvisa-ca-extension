// Release artifact smoke checks for the production `dist/` build.
// Verifies public branding, permissions, assets, and absence of dev surfaces.
// Never prints file contents (the production bundle may intentionally embed
// the owner's public PostHog ingestion token when built with .env.local).
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { filesUnder } from './archive-utils.mjs';
import { parseBrowserArgs } from './browser-target.mjs';

const PRODUCT_NAME = 'US Visa Scheduler for Canada';
const { target, args } = parseBrowserArgs(process.argv.slice(2));
const distDir = resolve(args[0] ?? target.outDir);
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const manifestPath = join(distDir, 'manifest.json');
check(existsSync(manifestPath), 'dist/manifest.json exists');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
check(manifest.name === PRODUCT_NAME, `manifest name is exactly "${PRODUCT_NAME}"`);
check(manifest.version === pkg.version, `manifest version matches package.json (${pkg.version})`);
check(typeof manifest.description === 'string' && manifest.description.length > 0 && manifest.description.length <= 132,
  'manifest description is present and within store limits');
for (const banned of ['Development', 'default-on', 'pending', 'Live validation']) {
  check(!String(manifest.description ?? '').includes(banned), `manifest description avoids "${banned}"`);
}
check(JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'alarms', 'activeTab', 'scripting', 'notifications']),
  'manifest permissions are the audited narrow set');
const allowedHosts = new Set(['https://ais.usvisa-info.com/*', 'https://us.i.posthog.com/*', 'https://eu.i.posthog.com/*']);
const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
check(hosts.includes('https://ais.usvisa-info.com/*'), 'manifest keeps the visa-site host permission');
check(hosts.every(h => allowedHosts.has(h)), 'manifest host permissions contain only allowlisted hosts');
check(new Set(hosts).size === hosts.length && hosts.length <= 2, 'manifest includes at most one analytics region');
check(!manifest.web_accessible_resources?.length, 'production exposes no developer iframe resources to websites');
check(manifest.action?.default_title === `Open ${PRODUCT_NAME}`, 'action title uses the product name');
for (const icon of ['icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png']) {
  check(existsSync(join(distDir, icon)), `dist contains ${icon}`);
}
for (const runtime of ['background.js', 'panel.html', 'panel.js']) {
  check(existsSync(join(distDir, runtime)), `dist contains ${runtime}`);
}
const panelHtml = existsSync(join(distDir, 'panel.html')) ? readFileSync(join(distDir, 'panel.html'), 'utf8') : '';
check(panelHtml.includes('<title>US Visa Scheduler</title>'), 'panel.html title uses the approved short display name');
// Production must not ship the developer probe page or its mutation tools.
for (const dev of ['probe.html', 'probe.js']) {
  check(!existsSync(join(distDir, dev)), `dist omits developer surface ${dev}`);
}
const flat = existsSync(distDir) ? filesUnder(distDir) : [];
const roots = new Set(['manifest.json', 'background.js', 'panel.html', 'panel.js']);
check(flat.every(file => roots.has(file) || /^assets\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:js|css|svg|png)$/.test(file) ||
  /^icons\/icon(?:16|32|48|128)\.png$/.test(file)), 'dist contains only allowlisted runtime files');
check(!flat.some(f => f.endsWith('.map')), 'dist contains no source maps');
check(!flat.some(f => f.startsWith('.env') || f === 'probe.css'), 'dist contains no private config or probe styles');
check(!flat.some(f => f.startsWith('test') || f.includes('fixture')), 'dist contains no test data or fixtures');
const panelJs = existsSync(join(distDir, 'panel.js')) ? readFileSync(join(distDir, 'panel.js'), 'utf8') : '';
check(!panelJs.includes('probe.html'), 'product panel bundle links no developer probe page');
const backgroundJs = existsSync(join(distDir, 'background.js')) ? readFileSync(join(distDir, 'background.js'), 'utf8') : '';
check(backgroundJs.includes(PRODUCT_NAME), 'worker bundle carries the product notification title');
check(!/phc_[A-Za-z0-9]{10,128}/.test(panelJs), 'product panel bundle embeds no analytics token');

if (failures.length > 0) {
  for (const failure of failures) console.error(`release-smoke FAIL: ${failure}`);
  process.exit(1);
}
console.log(`release-smoke OK: ${PRODUCT_NAME} ${pkg.version} (${flat.length} files, hosts: ${hosts.length})`);
