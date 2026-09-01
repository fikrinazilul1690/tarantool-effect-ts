import {Context, Data, Effect, Layer} from 'effect';
import nodemailer, {type Transporter} from 'nodemailer';

export class EmailError extends Data.TaggedError('EmailError')<{
  readonly operation: 'configure' | 'verify' | 'send';
  readonly cause: unknown;
}> {}

export interface VerificationEmail {
  readonly to: string;
  readonly name: string;
  readonly verificationUrl: string;
}

interface EmailShape {
  readonly sendVerification: (message: VerificationEmail) => Effect.Effect<void, EmailError>;
}

export class Email extends Context.Service<Email, EmailShape>()('learn-tarantool/Email') {}

const deliveryEnabled = process.env.EMAIL_DELIVERY_ENABLED === 'true';

const acquireTransport = Effect.acquireRelease(
  Effect.tryPromise({
    try: async (): Promise<Transporter | null> => {
      if (!deliveryEnabled) return null;
      const host = process.env.SMTP_HOST;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASSWORD;
      if (!host || !user || !pass || !process.env.EMAIL_FROM) {
        throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM are required');
      }
      const transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {user, pass},
      });
      await transporter.verify();
      return transporter;
    },
    catch: (cause) => new EmailError({operation: 'configure', cause}),
  }),
  (transporter) => Effect.sync(() => transporter?.close()),
);

export const EmailLive = Layer.effect(
  Email,
  Effect.gen(function*() {
    const transporter = yield* acquireTransport;
    const sendVerification = (message: VerificationEmail): Effect.Effect<void, EmailError> => {
      if (transporter === null) {
        return Effect.logWarning(
          `Email delivery disabled. Verification link for ${message.to}: ${message.verificationUrl}`,
        );
      }
      return Effect.tryPromise({
        try: () => transporter.sendMail({
          from: process.env.EMAIL_FROM!,
          to: message.to,
          subject: 'Verify your Learn Tarantool email address',
          text: `Hello ${message.name},\n\nVerify your email address:\n${message.verificationUrl}\n\nThis link expires in one hour.`,
          html: `<p>Hello ${escapeHtml(message.name)},</p><p>Please verify your email address:</p><p><a href="${escapeHtml(message.verificationUrl)}">Verify email</a></p><p>This link expires in one hour.</p>`,
        }).then(() => undefined),
        catch: (cause) => new EmailError({operation: 'send', cause}),
      });
    };
    return Email.of({sendVerification});
  }),
);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]!);
}
