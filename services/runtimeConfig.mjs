import dotenv from 'dotenv';
import path from 'node:path';

// A deployed container is configured only through its environment. A stray
// developer env file must not silently redirect production to localhost.
export function loadLocalEnvironment(directory, environment = process.env) {
  if (['production', 'test'].includes(environment.NODE_ENV)) return;
  dotenv.config({ path: path.join(directory, '.env'), processEnv: environment });
  dotenv.config({ path: path.join(directory, '.env.local'), processEnv: environment, override: true });
}

export function trustProxyHops(environment = process.env) {
  const value = environment.TRUST_PROXY_HOPS ?? '0';
  if (!/^[01]$/.test(String(value))) throw new Error('TRUST_PROXY_HOPS must be 0 or 1.');
  // Use 1 only when the API is reachable exclusively through the reverse proxy.
  return Number(value);
}

export function exportConcurrency(environment = process.env) {
  const value = environment.EXPORT_CONCURRENCY ?? (environment.NODE_ENV === 'production' ? '1' : '2');
  if (!/^[1-8]$/.test(String(value))) throw new Error('EXPORT_CONCURRENCY must be an integer from 1 to 8.');
  return Number(value);
}
