import { fileURLToPath } from 'node:url';
import { loadLocalEnvironment } from './services/runtimeConfig.mjs';

loadLocalEnvironment(fileURLToPath(new URL('.', import.meta.url)));
