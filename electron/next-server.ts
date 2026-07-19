// electron/next-server.ts
//
// THE EMBEDDED NEXT SERVER — design §2, running INSIDE the Electron main
// process (design §1: everything privileged lives in main).
//
// WHY A CUSTOM SERVER AND NOT `output: 'standalone'` (design §2.1)
// The two are mutually exclusive, and standalone's generated `server.js` calls
// `process.chdir(__dirname)` — you can never set a working directory inside an
// asar archive, so standalone-inside-asar is impossible by construction. Only
// the custom server exposes the `httpServer` option we need for port readback.
//
// WHY WE DO NOT REUSE `shell/server.mjs`
// The shell is a git submodule and we want ZERO diff against it, but that is the
// smaller reason. The bigger one is that `shell/server.mjs` is a CLI server, and
// two of its behaviours are actively wrong for a desktop app:
//
//   * it starts a SECOND "share server" bound to 0.0.0.0 (LAN review sharing).
//     Binding a non-loopback interface is a direct violation of design §5.3, and
//     it would be bound by the time any of our hardening ran.
//   * its auth gate is OPT-IN and exempts every loopback peer by design, i.e.
//     precisely the "other local processes" case that design §5.4 says the
//     session token exists to cover.
//
// It also `process.exit()`s on its single-instance check and installs signal
// handlers that would fight Electron's own lifecycle. So we host Next ourselves
// with the design's own pattern, and reuse the shell only as the Next APP DIR.
// The shell's tree is not modified in any way.
//
// PACKAGING NOTE (what this needs when it ships inside an asar)
// This module is dev-correct today and packaging-ready in every respect but one,
// which is called out explicitly rather than left to be discovered:
//
//   * `dir` is ABSOLUTE, from `app.getAppPath()` — design §2.2. `next({dir})`
//     defaults to `process.cwd()`, which in a packaged macOS app is typically
//     `/`. Never rely on cwd here.
//   * `next` is resolved out of the SHELL's node_modules via `createRequire`,
//     not the parent's — the shell is its own npm workspace tree and pins its
//     own Next. Inside asar this still works: asar is transparent to `require`.
//   * WRITABLE CACHES are the open item. A production Next server writes ISR,
//     fetch and image caches at runtime and the install location is read-only.
//     The doc-verified fix is a `cacheHandler` (plus `cacheHandlers` for
//     `'use cache'` and `images.customCacheHandler`) in next.config — i.e. a
//     SHELL-SIDE config change, which is exactly the submodule diff this task
//     is meant to avoid. Until the shell is trimmed in F1-03 (where its config
//     is rewritten anyway) we point the env vars we can at userData and accept
//     that this is best-effort: design §2.3 records that
//     `NEXT_PRIVATE_CACHE_DIR` circulates in community answers but could NOT be
//     confirmed in Next's source, so it is set as defence in depth and NOT
//     relied upon. See `applyWritableCacheEnv` below.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createGuard, type Guard } from './hardening.js';

// ---------------------------------------------------------------------------
// Minimal structural types for the Next entry point.
// ---------------------------------------------------------------------------
//
// `next` is required at runtime out of the SHELL's tree, so there is no import
// the parent's TypeScript can resolve and nothing to `import type`. Declaring
// the two-method surface we actually use keeps the file strict-clean without
// adding a parent-side dependency on Next purely for types.

type NextRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
type NextUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> | void;

type NextApp = {
  prepare(): Promise<void>;
  close?(): Promise<void>;
  getRequestHandler(): NextRequestHandler;
  getUpgradeHandler(): NextUpgradeHandler;
};

type NextFactory = (opts: {
  dev: boolean;
  dir: string;
  hostname?: string;
  port?: number;
  httpServer?: Server;
  customServer?: boolean;
}) => NextApp;

export type EmbeddedServer = {
  /** The port read back off the BOUND handle — never guessed, never probed. */
  readonly port: number;
  /** `http://127.0.0.1:<port>` — no token attached. */
  readonly origin: string;
  /** The bound address, asserted to be loopback. */
  readonly address: string;
  readonly guard: Guard;
  /** Idempotent. Resolves once the listener is closed and Next has shut down. */
  close(): Promise<void>;
};

export type StartOptions = {
  /** Absolute path to the shell (the Next app dir). */
  shellDir: string;
  /** Per-launch session token — see hardening.ts. */
  token: string;
  /** Writable directory for runtime caches (Electron's `userData`). */
  userDataDir: string;
  dev?: boolean;
  log?: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Writable caches (design §2.3) — best-effort, deliberately not load-bearing.
// ---------------------------------------------------------------------------

function applyWritableCacheEnv(userDataDir: string): string {
  const cacheDir = join(userDataDir, 'next-cache');
  mkdirSync(cacheDir, { recursive: true });
  // Unconfirmed in Next's source (design §2.3) — set, but never depended on.
  process.env.NEXT_PRIVATE_CACHE_DIR ??= cacheDir;
  return cacheDir;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function startEmbeddedNextServer(opts: StartOptions): Promise<EmbeddedServer> {
  const { shellDir, token, userDataDir, dev = false } = opts;
  const log = opts.log ?? (() => {});

  applyWritableCacheEnv(userDataDir);

  // The shell reads these to locate its own root and data dir. Setting them
  // here rather than patching the shell is what keeps the submodule diff at
  // zero — `server.mjs` sets exactly the same variables when run as a CLI.
  process.env.COCKPIT_ROOT ??= shellDir;
  process.env.COCKPIT_HOME ??= join(userDataDir, 'cockpit');
  mkdirSync(process.env.COCKPIT_HOME, { recursive: true });

  // ---- 1. Bind FIRST, then read the port off the handle (design §2.2) -----
  //
  // `listen(0)` asks the kernel for a free port and the bound handle then tells
  // us which one it got — no TOCTOU window between "find a free port" and "bind
  // it". This ordering is not a style preference: Next has NO production
  // port-collision fallback. Its EADDRINUSE retry is gated on dev mode; in
  // production it logs and exits. So the port must be one the kernel already
  // handed us, not one we hoped was free.
  //
  // The literal `127.0.0.1` (design §5.3) — never `0.0.0.0`, and never the name
  // `localhost`, which would drag in a resolver and can map to ::1 on some
  // hosts. 127.0.0.0/8 is unconditionally a secure context.

  let handle: NextRequestHandler | undefined;
  let upgrade: NextUpgradeHandler | undefined;
  let guard: Guard | undefined;

  // A 403 says nothing about WHY. The reason is logged locally for debugging;
  // returning it would hand an attacker a probe oracle for the token.
  const deny = (res: ServerResponse, reason: string): void => {
    log(`[hardening] 403 ${reason}`);
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden\n');
  };

  // EVERY request passes through here before it can reach Next. The guard is
  // the outermost layer by construction: `handle` is not even reachable from
  // any other listener, so there is no route that can be added later that
  // bypasses it.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!guard || !handle) {
      // Bound but not prepared yet. Cannot happen for the window (we only load
      // the URL after prepare resolves), but a local port scanner can hit this
      // window, and 503 is the honest answer.
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('503 Not Ready\n');
      return;
    }
    const verdict = guard.checkRequest(req);
    if (!verdict.ok) {
      deny(res, verdict.reason);
      return;
    }
    if (verdict.setCookie) res.setHeader('set-cookie', verdict.setCookie);
    void handle(req, res);
  });

  // WebSocket upgrades get the STRICTER policy (Origin mandatory). This is the
  // exact surface CVE-2025-52882 exploited: handshakes are not CORS-preflighted,
  // so if the server does not refuse them nothing else will.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!guard || !upgrade) {
      socket.destroy();
      return;
    }
    const verdict = guard.checkUpgrade(req);
    if (!verdict.ok) {
      log(`[hardening] 403 upgrade ${verdict.reason}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    void upgrade(req, socket, head);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error(`embedded server bound to an unexpected address: ${String(addr)}`);
  }
  const { port, address } = addr;

  // Fail loudly rather than serving the LAN. If this ever trips, control §5.3
  // has been broken and no amount of Host/Origin/token checking makes that
  // acceptable.
  if (address !== '127.0.0.1') {
    server.close();
    throw new Error(`refusing to serve: bound to ${address}, expected 127.0.0.1`);
  }

  guard = createGuard({ token, port });

  // ---- 2. Next, against the now-bound handle ------------------------------
  //
  // `httpServer` is what lets Next attach to the socket we already own instead
  // of opening its own. `customServer: true` keeps it out of the `next start`
  // code path (which would default the bind to 0.0.0.0).
  const shellRequire = createRequire(pathToFileURL(join(shellDir, 'package.json')).href);
  const nextModule = shellRequire('next') as NextFactory | { default: NextFactory };
  const nextFactory: NextFactory =
    typeof nextModule === 'function' ? nextModule : nextModule.default;

  const app = nextFactory({
    dev,
    dir: shellDir, // ABSOLUTE — design §2.2; cwd is `/` in a packaged mac app
    hostname: '127.0.0.1',
    port,
    httpServer: server,
    customServer: true,
  });

  await app.prepare();

  handle = app.getRequestHandler();
  upgrade = app.getUpgradeHandler();

  log(`[server] ready on http://127.0.0.1:${port} (loopback only, token required)`);

  let closed = false;
  return {
    port,
    address,
    origin: `http://127.0.0.1:${port}`,
    guard,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Stop accepting first, then let Next release its own resources. Keep-
      // alive sockets from the renderer would otherwise hold `close()` open,
      // so the window is expected to be gone by the time this runs; the
      // `closeAllConnections` call makes that independent of the window.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await app.close?.();
      } catch {
        // Next's close is best-effort; a failure here must not block quit.
      }
    },
  };
}
