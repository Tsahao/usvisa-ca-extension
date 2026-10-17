export type BrowserTarget = {
  name: 'chrome';
  manifestPath: string;
  outDir: string;
  artifactSuffix: string;
};
export function resolveBrowserTarget(name?: string): BrowserTarget;
export function parseBrowserArgs(argv: string[], env?: { BROWSER_TARGET?: string }): { target: BrowserTarget; args: string[] };
