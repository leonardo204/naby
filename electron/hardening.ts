// electron/hardening.ts
//
// LOCALHOST HARDENING — design §5, all four controls.
//
// A local HTTP server inside a desktop app is a proven CVE class. CVE-2025-52882
// (CVSS 8.8) was exactly this shape in Anthropic's own VS Code extension: a
// localhost WebSocket with no auth and no Origin validation, so any web page the
// user visited could read files and execute code. Vite's CVE-2025-24010 was a
// missing Host check. Electron EXEMPTS localhost from its renderer security
// warnings, so a vulnerable app's webPreferences look perfectly clean while the
// hole sits in the server — which is why this file exists as an explicit,
// testable unit rather than as a few `if`s sprinkled through the boot path.
//
// THE FOUR CONTROLS (design §5) AND WHERE EACH LIVES
//
//   1. Host  — validated here. This is the DNS-rebinding kill switch: a rebound
//      request still carries the ATTACKER's hostname in `Host`, so an exact
//      match against `127.0.0.1:<port>` refuses it even though the packet
//      arrived on loopback.
//   2. Origin — validated here, and STRICTLY on WebSocket upgrades. Handshakes
//      carry `Origin` and are NOT CORS-preflighted, so the server is the only
//      place that can refuse a cross-origin socket.
//   3. Bind 127.0.0.1 — enforced in next-server.ts (`listen(0, '127.0.0.1')`),
//      never 0.0.0.0. Note Next's own `next start` defaults to 0.0.0.0.
//   4. Per-launch random session token — minted here, required here on EVERY
//      request. This is the only control that covers OTHER LOCAL PROCESSES:
//      loopback is not an authentication boundary, and every other user-level
//      process on the machine can reach the port.
//
// PORT RANDOMIZATION IS NOT A MITIGATION and is not treated as one. The Claude
// Code attack defeated it by scanning from the attacker's page. The ephemeral
// port exists to avoid a collision (design §2.2), not to hide.
//
// WHY THE GUARD RETURNS A VERDICT INSTEAD OF WRITING THE RESPONSE
// It is called from two places with incompatible response mechanics — an
// `http.ServerResponse` for requests and a raw `Duplex` for upgrades. Returning
// data keeps the policy in ONE function that both paths must pass through, so a
// future handler cannot accidentally acquire its own softer copy of the rules.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// ---------------------------------------------------------------------------
// Wire names
// ---------------------------------------------------------------------------
//
// Three carriers, because one is not enough for a browser:
//
//   * QUERY PARAM — the FIRST navigation only. `loadURL()` is a top-level
//     navigation; there is no way to attach a header to it, so the token has to
//     ride the URL exactly once.
//   * COOKIE — every request after that. The guard sets it (HttpOnly, SameSite=
//     Strict, Path=/) the first time it sees a valid query token, so Next's own
//     asset/RSC/fetch traffic and the WebSocket handshake authenticate with no
//     cooperation from page code at all. SameSite=Strict is what stops a foreign
//     page from riding the cookie; the Origin check is the belt to its braces.
//   * HEADER — for code that explicitly authenticates (the renderer's own fetch
//     via the preload bridge, and non-browser callers such as the spike).
//
// HttpOnly is deliberate: the cookie is the ambient credential and script must
// not be able to read it. The renderer gets the token separately, through
// contextBridge, which is a channel a foreign page cannot reach.

export const TOKEN_QUERY_PARAM = '__naby_token';
export const TOKEN_HEADER = 'x-naby-session-token';
export const TOKEN_COOKIE = '__naby_session';

/** 256 bits — comfortably above the ≥128-bit floor the design requires. */
export function mintSessionToken(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type GuardVerdict =
  | { ok: true; setCookie?: string }
  | { ok: false; status: 403; reason: GuardDenyReason };

export type GuardDenyReason =
  | 'bad-host'
  | 'bad-origin'
  | 'missing-origin'
  | 'missing-token'
  | 'bad-token';

export type Guard = {
  /** The exact `Host` value every request must carry. */
  readonly expectedHost: string;
  /** The exact `Origin` value every cross-checked request must carry. */
  readonly expectedOrigin: string;
  /** Policy for a normal HTTP request. */
  checkRequest(req: IncomingMessage): GuardVerdict;
  /** Policy for a WebSocket upgrade — strictly stronger (Origin is mandatory). */
  checkUpgrade(req: IncomingMessage): GuardVerdict;
};

export type GuardOptions = {
  token: string;
  port: number;
  /** Always the literal loopback address; parameterised only for tests. */
  host?: string;
};

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------
//
// `timingSafeEqual` throws on a length mismatch, which would itself leak length
// through an exception path, so length is checked first and equal-length buffers
// are then compared in constant time. Token comparison is the one place in this
// file where a naive `===` would be a (small, local) real weakness.

function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------
//
// Node lower-cases header names but a duplicated header arrives as an array.
// A request carrying two `Host` headers is either a proxy bug or an attempt at
// request smuggling; either way we refuse rather than pick one, so `first()`
// returns undefined for the array case instead of `[0]`.

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return undefined;
  return value;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Pull the token out of a URL's query string without needing a valid base. */
function readQueryToken(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf('?');
  if (q === -1) return undefined;
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get(TOKEN_QUERY_PARAM) ?? undefined;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export function createGuard({ token, port, host = '127.0.0.1' }: GuardOptions): Guard {
  const expectedHost = `${host}:${port}`;
  const expectedOrigin = `http://${host}:${port}`;

  // Order matters for diagnosis, not for security — all four are mandatory, so
  // any single failure is a 403 and the reason is only ever logged locally,
  // never returned to the caller (see the 403 body in next-server.ts).
  function checkCommon(req: IncomingMessage, requireOrigin: boolean): GuardVerdict {
    // -- 1. Host ------------------------------------------------------------
    // Exact match. NOT a `startsWith`/`includes` test: `127.0.0.1:8080.evil.com`
    // contains the expected string, and a rebound DNS name resolving to
    // loopback is precisely the attack this check exists to stop.
    if (single(req.headers.host) !== expectedHost) {
      return { ok: false, status: 403, reason: 'bad-host' };
    }

    // -- 2. Origin ----------------------------------------------------------
    // Present-and-wrong is always fatal. Absent is fatal only for upgrades:
    // browsers ALWAYS send Origin on a WebSocket handshake, so a missing one
    // there means a non-browser caller and there is no reason to allow it. For
    // plain HTTP, the app's own top-level navigation legitimately has no Origin,
    // so absence falls through to the token check, which still gates it.
    const origin = single(req.headers.origin);
    if (origin !== undefined && origin !== expectedOrigin) {
      return { ok: false, status: 403, reason: 'bad-origin' };
    }
    if (origin === undefined && requireOrigin) {
      return { ok: false, status: 403, reason: 'missing-origin' };
    }

    // -- 4. Session token ---------------------------------------------------
    const headerToken = single(req.headers[TOKEN_HEADER]);
    const cookieToken = readCookie(single(req.headers.cookie), TOKEN_COOKIE);
    const queryToken = readQueryToken(req.url);
    const presented = headerToken ?? cookieToken ?? queryToken;

    if (presented === undefined) {
      return { ok: false, status: 403, reason: 'missing-token' };
    }
    if (!tokensMatch(token, presented)) {
      return { ok: false, status: 403, reason: 'bad-token' };
    }

    // Promote a URL-borne token to a cookie so the rest of the session needs no
    // URL rewriting. Only on the query path: re-setting it on every request
    // would be pointless churn on an HttpOnly cookie that cannot be cleared by
    // script anyway.
    if (headerToken === undefined && cookieToken === undefined) {
      return {
        ok: true,
        setCookie: `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
      };
    }
    return { ok: true };
  }

  return {
    expectedHost,
    expectedOrigin,
    checkRequest: (req) => checkCommon(req, false),
    checkUpgrade: (req) => checkCommon(req, true),
  };
}
