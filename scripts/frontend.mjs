import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// CRA exits when stdin closes unless CI=true. A detached local service has no
// interactive stdin, so explicitly disable that terminal-only shutdown hook.
process.env.CI = 'true';
process.env.BROWSER = 'none';
const frontend = fileURLToPath(new URL('../../web_frontend/', import.meta.url));
const log = (event, details = {}) => console.log(JSON.stringify({
  service: 'frontend', event, time: new Date().toISOString(), pid: process.pid, ...details,
}));
process.on('exit', code => log('exit', { code }));
process.on('uncaughtExceptionMonitor', error => log('uncaught_exception', {
  name: error.name, code: error.code || 'UNKNOWN',
}));
log('starting', { detached: true, stdinShutdownDisabled: true });
// Load the server in this process so the tracked PID is the serving process,
// rather than react-scripts' synchronous wrapper around another Node process.
createRequire(import.meta.url)(path.join(frontend, 'node_modules/react-scripts/scripts/start.js'));
