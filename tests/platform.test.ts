import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { platform } from '../src/platform';

afterEach(() => { vi.unstubAllGlobals(); });

describe('native browser platform seam', () => {
  it('imports without extension APIs and preserves the runtime-id presence check', async () => {
    vi.stubGlobal('chrome', undefined);
    vi.resetModules();
    const { platform: imported } = await import('../src/platform');
    expect(imported.hasRuntimeId).toBe(false);
    vi.stubGlobal('chrome', {});
    expect(imported.hasRuntimeId).toBe(false);
    vi.stubGlobal('chrome', { runtime: { id: '' } });
    expect(imported.hasRuntimeId).toBe(false);
    vi.stubGlobal('chrome', { runtime: { id: 'synthetic' } });
    expect(imported.hasRuntimeId).toBe(true);
  });

  it('returns native areas without capturing objects or filling absent events', () => {
    const areas = ['storage', 'tabs', 'scripting', 'alarms', 'notifications', 'windows', 'runtime', 'action'] as const;
    for (const area of areas) {
      const native = {};
      vi.stubGlobal('chrome', { [area]: native });
      expect(platform[area]).toBe(native);
      const replacement = {};
      vi.stubGlobal('chrome', { [area]: replacement });
      expect(platform[area]).toBe(replacement);
    }
    vi.stubGlobal('chrome', { tabs: {}, storage: {} });
    expect(platform.tabs.onUpdated).toBeUndefined();
    expect(platform.storage.onChanged).toBeUndefined();
  });

  it('preserves native receivers, callback returns, promises, errors and MAIN injection payloads', async () => {
    const failure = new Error('synthetic');
    const pending = Promise.resolve([{ result: 'synthetic' }]);
    const options = { target: { tabId: 7 }, world: 'MAIN' as const, func: () => 'synthetic' };
    const scripting = { executeScript(input: unknown) { expect(this).toBe(scripting); expect(input).toBe(options); return pending; } };
    const listener = vi.fn(() => true);
    const onMessage = { addListener(callback: (...args: any[]) => unknown) { expect(this).toBe(onMessage); expect(callback).toBe(listener); return callback(); } };
    const runtime = { onMessage, sendMessage(message: unknown, callback: (value: unknown) => void) {
      expect(this).toBe(runtime); callback(message); return undefined;
    } };
    const tabs = { get() { expect(this).toBe(tabs); throw failure; }, query() { return Promise.reject(failure); } };
    vi.stubGlobal('chrome', { scripting, runtime, tabs });
    expect(platform.scripting.executeScript(options)).toBe(pending);
    expect(platform.runtime.onMessage.addListener(listener)).toBe(true);
    const callback = vi.fn();
    expect(platform.runtime.sendMessage({ synthetic: true }, callback)).toBeUndefined();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ synthetic: true });
    expect(() => platform.tabs.get(7)).toThrow(failure);
    await expect(platform.tabs.query({})).rejects.toBe(failure);
  });

  it('keeps browser-global identifiers inside the seam (not in serializable adapters)', () => {
    function inspect(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (path !== 'src/platform') inspect(path); continue; }
        if (!/\.tsx?$/.test(path)) continue;
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (ts.isIdentifier(node)) expect(node.text === 'chrome', path).toBe(false);
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    inspect('src');
  });
});
