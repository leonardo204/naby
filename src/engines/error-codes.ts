// ---------------------------------------------------------------------------
// error-codes.ts — the stable `code` on an engine's `error` event.
//
// The `message` of an error event is the provider's or the engine's own text:
// verbatim, English, sometimes a paragraph. The chat shows the user localized,
// actionable copy instead, and it needs something stable to key that on — the
// `code`. This file holds the codes that the user can do something about and
// the one classifier that turns a thrown provider error into one of them.
//
// Codes the chat client knows (shell useChatStream → runErrorCopy):
//
//   PROVIDER_AUTH_FAILED   the API key was rejected (HTTP 401 / 403)
//   PROVIDER_RATE_LIMITED  the provider said "too many requests" (HTTP 429)
//   ENGINE_THREW           anything else the model step threw
//   MAX_STEPS_EXCEEDED     the tool-loop cap (ai-sdk-engine)
//   GATE_BYPASSED / NO_EXECUTOR  internal wiring errors — the user is told
//                          "internal error, send again"; the detail is logged
//
// plus the Claude Agent SDK's own assistant-error values, passed through as-is
// (`authentication_failed`, `rate_limit`, `billing_error`, …).
// ---------------------------------------------------------------------------

/** The HTTP status a thrown provider error carries, when it carries one. */
export function httpStatusOf(e: unknown): number | undefined {
  const fromObject = (o: unknown): number | undefined => {
    if (!o || typeof o !== 'object') return undefined;
    const rec = o as { statusCode?: unknown; status?: unknown };
    if (typeof rec.statusCode === 'number') return rec.statusCode;
    if (typeof rec.status === 'number') return rec.status;
    return undefined;
  };
  const direct = fromObject(e) ?? fromObject((e as { cause?: unknown } | null)?.cause);
  if (direct !== undefined) return direct;
  // A wrapped error ("Failed after 3 attempts. Last error: … 429 …") keeps only
  // the text. Matched as a whole word next to HTTP-ish context, so a token count
  // or a model name with those digits in it is not mistaken for a status.
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = text.match(/\b(?:status(?:\s*code)?|HTTP)\s*[:=]?\s*(401|403|429)\b|\b(401|403|429)\s+(?:Unauthorized|Forbidden|Too Many Requests)\b/i);
  const hit = m?.[1] ?? m?.[2];
  return hit ? Number(hit) : undefined;
}

/** The code for an error a metered provider's model step threw. */
export function providerErrorCode(e: unknown): 'PROVIDER_AUTH_FAILED' | 'PROVIDER_RATE_LIMITED' | 'ENGINE_THREW' {
  const status = httpStatusOf(e);
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  return 'ENGINE_THREW';
}

/**
 * The code for a Claude Agent SDK turn that failed outright (the CLI process
 * exited). It answers with the Claude sign-in, not an API key, so an auth
 * failure is the SDK's own `authentication_failed` (sign in again) and a 429 its
 * `rate_limit` (plan usage limit) — the same codes its assistant errors carry.
 */
export function claudeSdkFailureCode(message: string): 'authentication_failed' | 'rate_limit' | 'ENGINE_THREW' {
  const status = httpStatusOf(message);
  if (status === 401 || status === 403 || /\b(?:authentication_failed|not logged in|please run \/login|invalid api key|oauth token has expired)\b/i.test(message)) {
    return 'authentication_failed';
  }
  if (status === 429 || /\b(?:rate_limit|usage limit)\b/i.test(message)) return 'rate_limit';
  return 'ENGINE_THREW';
}
