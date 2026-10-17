// Target catalog only. Unsupported placeholders must fail before any build,
// smoke check or archive can accidentally reuse a Chrome artifact.
const targets = {
  chrome: { name: 'chrome', manifestPath: 'public/manifest.json', outDir: 'dist', artifactSuffix: '' },
  safari: null, // Reserved placeholder, not an implementation.
};

export function resolveBrowserTarget(name = 'chrome') {
  if (!Object.hasOwn(targets, name)) throw new Error(`Unknown browser target "${name}". Choose ${Object.keys(targets).join(' or ')}.`);
  const target = targets[name];
  if (!target) throw new Error(`Browser target "${name}" is a placeholder; build and packaging are not implemented.`);
  return target;
}

// CLI --browser takes precedence over BROWSER_TARGET. Keep remaining arguments
// intact (Vite build flags, or the smoke check's existing positional dist path).
export function parseBrowserArgs(argv, env = process.env) {
  let name = env.BROWSER_TARGET ?? 'chrome';
  let specified = false;
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--browser' || arg.startsWith('--browser=')) {
      if (specified) throw new Error('Specify --browser only once.');
      specified = true;
      const value = arg === '--browser' ? argv[++index] : arg.slice('--browser='.length);
      if (!value || value.startsWith('--')) throw new Error('--browser requires a target.');
      name = value;
    } else args.push(arg);
  }
  return { target: resolveBrowserTarget(name), args };
}
