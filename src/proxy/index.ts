// ASX Proxy public API for CLI integration.
export type { ProxyHandle, ProxyStartOptions, TargetCred } from './types.js';
export { injectProxyEndpoint } from './inject.js';
export { startProxy } from './server.js';

export async function startProxyForExec(opts: {
  sourceProvider: string;
  targetProvider: string;
  targetCredential: any;
  tmpDir?: string;
}) {
  const { startProxy } = await import('./server.js');
  return startProxy({
    sourceProvider: opts.sourceProvider,
    targetProvider: opts.targetProvider,
    targetCredential: opts.targetCredential,
    tmpDir: opts.tmpDir,
  });
}
