import '../config.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('A Stripe TEST key is required.');
const destination = fileURLToPath(new URL('../.env.local', import.meta.url));
const child = spawn('stripe', ['listen', '--forward-to', 'http://localhost:5000/api/payment/webhook',
  '--events', 'checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted'], {
  env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY }, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
function line(text) {
  const secret = text.match(/whsec_[A-Za-z0-9]+/);
  if (secret) {
    let contents = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
    const value = `STRIPE_WEBHOOK_SECRET=${secret[0]}`;
    contents = /^STRIPE_WEBHOOK_SECRET=.*$/m.test(contents)
      ? contents.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, value) : `${contents.trimEnd()}\n${value}\n`;
    fs.writeFileSync(destination, contents, { mode: 0o600 });
    console.log('Stripe TEST webhook ready; signing secret saved to backend/.env.local. Restart the API to load it.');
  }
  console.log(text.replace(/(?:whsec_|sk_test_|sk_live_|rk_test_|rk_live_)[A-Za-z0-9_-]+/g, '[redacted]'));
}
for (const stream of [child.stdout, child.stderr]) {
  let pending = '';
  stream.on('data', data => {
    pending += data.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const text of lines) line(text);
  });
  stream.on('end', () => { if (pending) line(pending); });
}
child.on('error', error => {
  console.error(`Stripe CLI could not start: ${error.code || 'error'}. Run stripe login if authorization is required.`);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code || process.exitCode || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
