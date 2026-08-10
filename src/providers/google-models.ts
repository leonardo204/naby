// src/providers/google-models.ts
//
// "Which Gemini models may this key use" — asked of Google, not hardcoded.
//
// WHY THIS IS IN THE RUNTIME AND NOT IN THE SHELL
// One API key opens a whole catalogue for Google, and that catalogue changes
// without us. Everything below is provider knowledge (an endpoint, a response
// shape, the rule for what counts as a chat model) plus a pure parser — exactly
// the code that must survive a UI rewrite or a second front end, which is what
// puts it here rather than beside the HTTP action that calls it. It mirrors
// `probeClaudeModels`, the equivalent question for the local Claude sign-in.
//
// THE KEY NEVER TRAVELS ANYWHERE BUT INTO THE REQUEST HEADER. The caller (the
// shell's `models.list` action) resolves it through `resolveProviderCredential`,
// hands it here, and returns model IDS to the renderer — never the key.
//
// DELIBERATE DEVIATION FROM THE DOCUMENTED `?key=` FORM. Google accepts the key
// either as a `?key=` query parameter or as the `x-goog-api-key` header, and
// this uses the HEADER. A key in a URL ends up in every place a URL ends up: an
// exception message ("fetch failed for https://…?key=AIza…"), a proxy log, a
// crash report. Since the whole point of this module is that the secret stops
// here, the shape that cannot leak it into a string is the one to use. The
// endpoint and the filtering rule are otherwise exactly as specified.

/** The v1beta catalogue endpoint. No key in it — see the header. */
export const GOOGLE_MODELS_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models';

/** One page is enough: Google lists tens of models, not thousands. Asked for
 *  explicitly because the server default (50) would silently TRUNCATE. */
export const GOOGLE_MODELS_PAGE_SIZE = 1000;

/** A catalogue lookup is a nicety, never a blocker: a settings screen must not
 *  hang on it, so it is abandoned well before any user would call it broken. */
export const GOOGLE_MODELS_TIMEOUT_MS = 8000;

/** The generation method a model must support to be usable as a chat model.
 *  Embedding and legacy models advertise other methods and are dropped. */
const GENERATE_CONTENT = 'generateContent';

/** `models/gemini-2.5-pro` → `gemini-2.5-pro`. The API answers with the resource
 *  NAME; every other surface (the profile's `model`, the turn's `requestedModel`,
 *  `@ai-sdk/google`) speaks the bare id. */
function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/**
 * The response → the model ids worth offering.
 *
 * PURE, and defensive at every step, because this parses a remote document: a
 * shape change at Google must read as "no models" (the caller then keeps its
 * cache) and never as a thrown error inside a settings screen. Order is kept as
 * Google returned it, and duplicates are dropped.
 */
export function parseGoogleModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { name?: unknown; supportedGenerationMethods?: unknown };
    if (typeof row.name !== 'string' || !row.name.trim()) continue;
    const methods = row.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes(GENERATE_CONTENT)) continue;
    const id = stripModelsPrefix(row.name.trim());
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type GoogleModelListOptions = {
  /** Used once, for one request header. Never stored, logged or returned. */
  apiKey: string;
  /** Injection seam: the tests drive the whole path with no network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Ask Google which models this key may use.
 *
 * `undefined` means "could not ask" (no network, a refusal, a timeout, an
 * unparseable body) as distinct from `[]`, which means "asked, and nothing
 * qualifies". The caller needs that distinction to decide whether to keep a
 * cached list — which is why nothing here throws.
 */
export async function listGoogleModels(
  opts: GoogleModelListOptions,
): Promise<string[] | undefined> {
  if (!opts.apiKey) return undefined;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? GOOGLE_MODELS_TIMEOUT_MS,
  );
  try {
    const url = `${GOOGLE_MODELS_ENDPOINT}?pageSize=${GOOGLE_MODELS_PAGE_SIZE}`;
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'x-goog-api-key': opts.apiKey, accept: 'application/json' },
      signal: controller.signal,
    });
    // A 400/403 is the ordinary answer to a wrong or unentitled key. It is the
    // caller's cache that covers it, not an exception.
    if (!res.ok) return undefined;
    const payload = (await res.json()) as unknown;
    return parseGoogleModelList(payload);
  } catch {
    // Offline, aborted, or a body that is not JSON. Same answer: could not ask.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
