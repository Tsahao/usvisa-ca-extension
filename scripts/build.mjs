// npm run build -- --browser chrome (default), or BROWSER_TARGET=chrome.
// Resolve before typechecking or invoking Vite, so placeholders build nothing.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseBrowserArgs } from './browser-target.mjs';

const { target, args } = parseBrowserArgs(process.argv.slice(2));
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit'], { stdio: 'inherit' });
execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', ...args], {
  stdio: 'inherit', env: { ...process.env, BROWSER_TARGET: target.name },
});
