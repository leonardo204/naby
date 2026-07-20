// electron/preload.ts
//
// THE BRIDGE — design §1. Compiled to `preload.cjs`, NOT an ESM module:
// a SANDBOXED preload must be CommonJS, and `sandbox: true` is not negotiable
// here (design §1 keeps every Electron 43 security default on). A sandboxed
// preload still gets `contextBridge` and `ipcRenderer`, which is all a bridge
// needs, so the sandbox costs us nothing.
//
// WHAT CROSSES, AND WHY THAT IS ALL
// Exactly one value and one helper. `ipcRenderer` is NEVER exposed wholesale —
// handing the renderer a general-purpose channel means every current and future
// `ipcMain` handler is reachable from any script that achieves execution in the
// page. When IPC handlers do arrive (F1-04's key entry is the first), each gets
// its own named function here and validates `event.senderFrame` on the main
// side; there is deliberately no `invoke(channel, ...)` escape hatch to add
// them through.
//
// WHY THE TOKEN COMES FROM argv AND NOT FROM IPC
// `additionalArguments` (see boot.ts) is delivered before any page script runs,
// so the credential is present from the renderer's first instruction. An IPC
// fetch would be async, and page code could observe the window in which the
// token is not yet there. A foreign page cannot read argv and cannot reach this
// isolated world, so argv is strictly the tighter channel.
//
// STRUCTURED CLONE governs everything that crosses (design §1): symbols and
// prototypes are dropped, and an error thrown in an `ipcMain.handle` handler
// arrives with only its `.message`. Anything that must survive the trip travels
// as plain data — which is why the error taxonomy is data, not exception types.

import { contextBridge, ipcRenderer } from 'electron';

const TOKEN_HEADER = 'x-naby-session-token';
const TOKEN_PREFIX = '--naby-session-token=';
const ORIGIN_PREFIX = '--naby-origin=';

function readArg(prefix: string): string {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const sessionToken = readArg(TOKEN_PREFIX);
const serverOrigin = readArg(ORIGIN_PREFIX);

/**
 * The shape `nabyFetch` resolves to.
 *
 * IT IS PLAIN DATA, AND THAT IS FORCED, NOT STYLISTIC. `contextBridge` copies
 * OWN ENUMERABLE properties and drops prototypes — the same structured-clone
 * discipline design §1 states for IPC. `Response` carries `status`, `ok` and
 * `headers` as GETTERS ON ITS PROTOTYPE, so a `Response` handed across the
 * bridge arrives with every one of them `undefined`: the call appears to
 * succeed and silently yields nothing. (SPIKE-04 caught exactly this.)
 *
 * So the response is flattened here, on the privileged side, into a value that
 * survives the crossing. The same rule applies to every function added to this
 * bridge later — return data, never a host object.
 */
export type NabyResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
};

/**
 * Page-side fetch that carries the session token explicitly.
 *
 * The HttpOnly cookie the guard sets on first navigation already authenticates
 * same-origin traffic, so this is not strictly required — it exists so that page
 * code can authenticate a request WITHOUT depending on ambient cookie behaviour
 * (which varies for service workers and `credentials: 'omit'` callers). Same-
 * origin is enforced here as well as in the server, so a bug in page code cannot
 * turn this into a token exfiltration primitive.
 */
async function nabyFetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<NabyResponse> {
  const url = new URL(input, serverOrigin || undefined);
  if (serverOrigin && url.origin !== serverOrigin) {
    throw new Error(`naby: refusing to attach the session token to ${url.origin}`);
  }
  const res = await fetch(url.toString(), {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: { ...(init?.headers ?? {}), [TOKEN_HEADER]: sessionToken },
    credentials: 'same-origin',
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ok: res.ok, status: res.status, headers, body: await res.text() };
}

// ---------------------------------------------------------------------------
// F1-04 — credential and provider channels (contract §1.3)
// ---------------------------------------------------------------------------
//
// This is the first IPC on the bridge, and it is deliberately built the way the
// header above promised: ONE NAMED FUNCTION PER CHANNEL, each hardcoding its
// channel name. There is no `invoke(channel, payload)` here, because such a
// helper would make every present and future `ipcMain.handle` — including ones
// added by code that never considered the renderer a threat — reachable from
// any script that achieves execution in the page. The cost of the rule is a
// line per channel; the benefit is that the reachable IPC surface is exactly
// this list and is auditable by reading it.
//
// WHAT DOES NOT EXIST HERE, AND MUST NOT: any way to READ a key. `status`
// answers `{stored, backend, secure}`. There is no `credentials.get`, no
// `credentials.reveal`, and no channel on the main side that would answer one.
// A stored key travels exactly one way — from the vault into the engine, in the
// main process — and never crosses back through this file.
//
// Every one of these resolves to the `Result<T>` envelope (contract §1.2) as
// PLAIN DATA. Same rule as `nabyFetch`: nothing that relies on a prototype
// survives the crossing, so main never returns a host object and never throws.

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; detail?: string } };

const credentials = {
  /** `{stored, backend, secure}` for one provider. NEVER the key. */
  status: (providerId: string): Promise<Result<{ stored: boolean; backend: string; secure: boolean }>> =>
    ipcRenderer.invoke('credential:status', { providerId }),

  /**
   * Store (or replace) a provider key.
   *
   * `acknowledgeInsecure` is how the "no secure store on this machine" case is
   * handled without either lying or bricking the app: main REFUSES with
   * CREDENTIAL_INSECURE unless it is set, and the UI only sets it after the
   * user has been shown the warning and confirmed. See credentials.ts.
   */
  set: (
    providerId: string,
    key: string,
    opts?: { acknowledgeInsecure?: boolean },
  ): Promise<Result<{ secure: boolean }>> =>
    ipcRenderer.invoke('credential:set', {
      providerId,
      key,
      acknowledgeInsecure: opts?.acknowledgeInsecure === true,
    }),

  clear: (providerId: string): Promise<Result<void>> =>
    ipcRenderer.invoke('credential:clear', { providerId }),
};

const providers = {
  /** Stored profiles (no secrets — contract §4), each with a `stored` flag. */
  list: (): Promise<Result<unknown[]>> => ipcRenderer.invoke('provider:list'),
  /** The five kinds and the fields each needs, from `describeProviders()`. */
  describe: (): Promise<Result<unknown>> => ipcRenderer.invoke('provider:describe'),
  upsert: (profile: unknown): Promise<Result<void>> => ipcRenderer.invoke('provider:upsert', profile),
  select: (sessionId: string, providerId: string): Promise<Result<void>> =>
    ipcRenderer.invoke('provider:select', { sessionId, providerId }),
};

const onboarding = {
  /** F1-06. `{onboarded, configured, skipped, security}`. */
  state: (): Promise<Result<unknown>> => ipcRenderer.invoke('onboarding:state'),
  /** Records an explicit dismissal, so "skip" does not loop forever. */
  complete: (): Promise<Result<void>> => ipcRenderer.invoke('onboarding:complete'),
};

contextBridge.exposeInMainWorld('naby', {
  /** Per-launch session token (design §5.4). Required on every request. */
  sessionToken,
  /** `http://127.0.0.1:<ephemeral port>` — the only origin this app talks to. */
  serverOrigin,
  /** Header name, so page code never has to hardcode the wire name. */
  tokenHeader: TOKEN_HEADER,
  /** Resolves to plain data — see NabyResponse. Never a `Response`. */
  fetch: nabyFetch,
  /** F1-04 — key entry and status. No read path, by construction. */
  credentials,
  /** F1-04 — provider profiles and the registry's self-description. */
  providers,
  /** F1-06 — first-run wizard state. */
  onboarding,
});
