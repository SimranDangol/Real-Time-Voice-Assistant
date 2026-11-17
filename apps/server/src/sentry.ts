import * as Sentry from "@sentry/node";

let enabled = false;

export function initErrorReporting(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    beforeSend(event) {
      if (event.request) {
        event.request.data = undefined;
        event.request.cookies = undefined;
        event.request.headers = undefined;
        if (event.request.url) {
          event.request.url = event.request.url.split(/[?#]/, 1)[0];
        }
      }

      event.breadcrumbs = undefined;
      const secrets = [
        process.env.DEEPGRAM_API_KEY,
        process.env.GROQ_API_KEY,
        process.env.OPENAI_API_KEY,
        process.env.CARTESIA_API_KEY,
        process.env.ELEVENLABS_API_KEY,
      ].filter((secret): secret is string => Boolean(secret));
      const redact = (value: string) =>
        secrets.reduce((sanitized, secret) => sanitized.replaceAll(secret, "[REDACTED]"), value);

      if (event.message) event.message = redact(event.message);
      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = redact(exception.value);
      }
      return event;
    },
  });
  enabled = true;
}

export function captureError(error: unknown, tags: Record<string, string> = {}): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

export async function flushErrorReporting(): Promise<void> {
  if (enabled) await Sentry.flush(2000);
}
