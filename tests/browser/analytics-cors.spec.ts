import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import type { AnalyticsRecord } from '../../src/analytics/store';

test('permission-free worker enforces real HTTP CORS and preserves durable analytics retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'usvisa-cors-'));
  const extension = path.join(root, 'extension');
  const requests: { method: string; origin?: string; url: string; body: string; cookie?: string; referer?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, origin: req.headers.origin, url: req.url!, body,
      cookie: req.headers.cookie, referer: req.headers.referer });
    if (req.url !== '/blocked' && !(req.url === '/response-blocked' && req.method === 'POST')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/timeout') return; // Transport must abort, not accept.
    res.writeHead(req.url === '/error' ? 503 : req.url === '/limited' ? 429 : 200); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const launch = () => chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  try {
    await build({ configFile: false, logLevel: 'silent', build: { outDir: extension, emptyOutDir: true,
      lib: { entry: path.resolve('tests/browser/fixtures/analytics-cors-worker.ts'), formats: ['es'], fileName: () => 'worker.js' } } });
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic CORS fixture',
      version: '0.0.1', permissions: ['storage'], host_permissions: ['https://ais.usvisa-info.com/*'],
      background: { service_worker: 'worker.js', type: 'module' } }));
    context = await launch();
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    expect(await worker.evaluate(() => chrome.runtime.getManifest().host_permissions)).toEqual(['https://ais.usvisa-info.com/*']);
    const send = (route: string, timeout = 1000) => worker.evaluate(async ({ url, timeout }) =>
      (globalThis as any).analyticsProbe.send(url, timeout), { url: base + route, timeout });
    expect(await send('/ok')).toBe(true);
    expect(await send('/blocked')).toBe(false);
    expect(requests.some(r => r.url === '/blocked' && r.method === 'POST')).toBe(false);
    expect(await send('/response-blocked')).toBe(false);
    expect(requests.some(r => r.url === '/response-blocked' && r.method === 'POST')).toBe(true);
    expect(await send('/error')).toBe(false);
    expect(await send('/limited')).toBe(false);
    expect(await send('/timeout', 100)).toBe(false);
    expect(requests.filter(r => r.url === '/ok').map(r => r.method)).toEqual(['OPTIONS', 'POST']);
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    expect(requests.every(r => r.origin === origin && !r.cookie && !r.referer)).toBe(true);
    const uuid = await worker.evaluate(() => (globalThis as any).analyticsProbe.seed());
    const failed = await worker.evaluate(url => (globalThis as any).analyticsProbe.flush(url), base + '/error');
    expect(failed.analyticsV1.outbox[0]).toMatchObject({ uuid, attempts: 1 });
    expect(Date.parse(failed.analyticsV1.nextFlushAt)).toBeGreaterThan(Date.now());
    expect(failed.workflowSentinel).toBe('unchanged');
    await context.close(); context = undefined;
    context = await launch();
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    // A fresh worker still honors the saved wait instead of busy-retrying.
    const before = requests.length;
    const waiting = await worker.evaluate(url => (globalThis as any).analyticsProbe.flush(url), base + '/ok');
    expect(requests.length).toBe(before);
    expect(waiting.analyticsV1.outbox[0].uuid).toBe(uuid);
    await worker.evaluate(async () => {
      const { analyticsV1 } = await chrome.storage.local.get('analyticsV1');
      await chrome.storage.local.set({ analyticsV1: { ...(analyticsV1 as AnalyticsRecord), nextFlushAt: new Date().toISOString() } });
    });
    const delivered = await worker.evaluate(url => (globalThis as any).analyticsProbe.flush(url), base + '/ok');
    expect(delivered.analyticsV1.outbox).toEqual([]);
    expect(delivered.workflowSentinel).toBe('unchanged');
    const copies = requests.filter(r => r.method === 'POST').map(r => JSON.parse(r.body)).filter(b => b.uuid === uuid);
    expect(copies).toHaveLength(2);
    expect(copies[1]).toEqual(copies[0]);
    await worker.evaluate(() => (globalThis as any).analyticsProbe.seed());
    for (let attempt = 1; attempt <= 10; attempt++) {
      await worker.evaluate(async () => {
        const { analyticsV1 } = await chrome.storage.local.get('analyticsV1');
        await chrome.storage.local.set({ analyticsV1: { ...(analyticsV1 as AnalyticsRecord), nextFlushAt: null } });
      });
      const exhausted = await worker.evaluate(url => (globalThis as any).analyticsProbe.flush(url), base + '/error');
      if (attempt < 10) expect(exhausted.analyticsV1.outbox[0].attempts).toBe(attempt);
      else expect(exhausted.analyticsV1.outbox).toEqual([]);
      expect(exhausted.workflowSentinel).toBe('unchanged');
    }
  } finally {
    await context?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
