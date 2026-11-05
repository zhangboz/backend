import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';

class EmailDeliveryError extends Error {
  constructor(code, message = 'Confirmation email is temporarily unavailable. Please try again later.') {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code;
    this.statusCode = 503;
    this.expose = true;
  }
}

const htmlEscape = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function timeoutMilliseconds(environment) {
  const timeout = Number(environment.EMAIL_TIMEOUT_MS || 10_000);
  return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 30_000 ? timeout : 10_000;
}

export function createEmailService({ environment = process.env, fetchImpl = globalThis.fetch,
  createTransport = nodemailer.createTransport, logger = console } = {}) {
  let transporter;

  function assertConfigured() {
    const production = environment.NODE_ENV === 'production';
    const provider = environment.EMAIL_PROVIDER || (production ? 'resend' : 'smtp');
    if (!['smtp', 'resend'].includes(provider) || (production && provider === 'smtp')) {
      throw new EmailDeliveryError('EMAIL_PROVIDER_UNSUPPORTED',
        'Email confirmation requires the HTTPS email provider on this server. Please use Google login or contact the site owner.');
    }
    const from = environment.MAIL_FROM || (provider === 'smtp' && environment.MAIL_USER ? `"Homework Help AI" <${environment.MAIL_USER}>` : '');
    let baseUrl;
    try {
      baseUrl = new URL(environment.BACKEND_URL || 'http://localhost:5000');
      if (!['http:', 'https:'].includes(baseUrl.protocol) || (production && baseUrl.protocol !== 'https:') || baseUrl.username || baseUrl.password) throw new Error();
    } catch {
      throw new EmailDeliveryError('EMAIL_NOT_CONFIGURED', 'Email confirmation is not configured. Please use Google login or contact the site owner.');
    }
    if (!from || /[\r\n]/.test(from) ||
      (provider === 'resend' ? !environment.RESEND_API_KEY : !environment.MAIL_USER || !environment.MAIL_PASS)) {
      throw new EmailDeliveryError('EMAIL_NOT_CONFIGURED', 'Email confirmation is not configured. Please use Google login or contact the site owner.');
    }
    return { provider, from, baseUrl };
  }

  async function sendConfirmationEmail(userEmail, token) {
    const production = environment.NODE_ENV === 'production';
    const provider = environment.EMAIL_PROVIDER || (production ? 'resend' : 'smtp');
    try {
      const settings = assertConfigured();
      if (typeof userEmail !== 'string' || userEmail.length > 254 || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(userEmail) ||
        typeof token !== 'string' || !token || token.length > 512) {
        throw new EmailDeliveryError('EMAIL_INVALID_INPUT');
      }
      const confirmationUrl = new URL('/api/login/confirm-email/' + encodeURIComponent(token), settings.baseUrl).toString();
      const escapedUrl = htmlEscape(confirmationUrl);
      const message = {
        from: settings.from,
        to: [userEmail],
        subject: 'Confirm Your Email for Homework Help AI',
        text: `Welcome to Homework Help AI! Confirm your email: ${confirmationUrl}\nThis link will expire in 1 hour.`,
        html: `<div style="font-family: sans-serif; text-align: center; padding: 20px;">
          <h2>Welcome to Homework Help AI!</h2>
          <p>Thank you for registering. Please confirm your email address.</p>
          <a href="${escapedUrl}">Confirm Email</a>
          <p>If the button does not work, copy this link into your browser:</p>
          <p><a href="${escapedUrl}">${escapedUrl}</a></p>
          <p>This link will expire in 1 hour.</p>
        </div>`,
      };
      const timeout = timeoutMilliseconds(environment);
      if (provider === 'resend') {
        // Same recipient/token retries do not produce duplicate emails; raw tokens stay out of headers/logs.
        const idempotencyKey = createHash('sha256').update(userEmail).update('\n').update(token).digest('hex');
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${environment.RESEND_API_KEY}`, 'Content-Type': 'application/json',
            'User-Agent': 'HomeworkHelpAI/1.0', 'Idempotency-Key': 'confirm-' + idempotencyKey },
          body: JSON.stringify(message), signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new EmailDeliveryError(response.status === 429 ? 'EMAIL_RATE_LIMITED'
            : [401, 403].includes(response.status) ? 'EMAIL_PROVIDER_REJECTED' : 'EMAIL_UNAVAILABLE');
        }
        const result = await response.json();
        if (!result?.id || typeof result.id !== 'string') throw new EmailDeliveryError('EMAIL_INVALID_RESPONSE');
      } else {
        transporter ||= createTransport({ service: 'gmail',
          auth: { user: environment.MAIL_USER, pass: environment.MAIL_PASS },
          connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout,
        });
        await transporter.sendMail(message);
      }
      logger.info?.(JSON.stringify({ event: 'confirmation_email_sent', provider }));
    } catch (error) {
      const safe = error instanceof EmailDeliveryError ? error
        : new EmailDeliveryError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'EMAIL_TIMEOUT' : 'EMAIL_UNAVAILABLE');
      logger.error?.(JSON.stringify({ event: 'confirmation_email_failed',
        provider: ['smtp', 'resend'].includes(provider) ? provider : 'unsupported', code: safe.code }));
      throw safe;
    }
  }

  return { sendConfirmationEmail, assertConfigured };
}

const emailService = createEmailService();
export const sendConfirmationEmail = emailService.sendConfirmationEmail;
export const assertEmailConfigured = emailService.assertConfigured;
