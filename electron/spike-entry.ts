// electron/spike-entry.ts
//
// SPIKE-04's payload — the code that runs INSIDE the Electron main process.
//
// It is a thin harness over the REAL boot path (`boot()` / `createMainWindow()`
// from boot.ts), not a re-implementation of it. That distinction is the whole
// point: a spike that stands up its own server would prove that the spike's
// server works. Every probe below runs against the same objects `main.ts`
// constructs, in the same process, in the same order.
//
// It emits one NDJSON line per observation on stdout, prefixed so the driver
// (`src/spikes/spike-04-electron.ts`) can pick them out of Electron's own
// chatter, and then quits. Nothing here decides PASS/FAIL — the driver does, so
// that a silently-missing probe is a FAIL rather than an absent assertion.
//
// Headless: hardware acceleration is disabled and the window is never shown, so
// this runs unattended. No human ever has to look at a window for it to pass.

import { app } from 'electron';
import { request as httpRequest } from 'node:http';
import { existsSync, statSync, writeSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { boot, createMainWindow } from './boot.js';
import { TOKEN_HEADER } from './hardening.js';
import type { Store } from '../dist/naby-runtime.mjs';

const MARK = '##SPIKE04##';

function emit(event: string, data: Record<string, unknown>): void {
  // writeSync, not process.stdout.write. On a pipe, the async write's callback
  // fires when libuv ACCEPTS the buffer, not when the OS has it — so a flush
  // guard built on that callback returns before the data has actually left the
  // process, and the following app.exit() discards it. That lost the final
  // observation roughly one run in five and made assertion (f) look flaky when
  // teardown was in fact clean. writeSync goes to the fd and does not return
  // until the kernel has taken the bytes.
  writeSync(1, `${MARK}${JSON.stringify({ event, ...data })}\n`);
}

// Electron's GPU process is pure overhead here and is the usual reason a
// headless/CI run hangs or spews. Must be called before `ready`.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ---------------------------------------------------------------------------
// Probe helper — a raw HTTP request with fully controlled headers.
// ---------------------------------------------------------------------------
//
// `fetch` cannot do this: it forbids setting `Host` and rewrites `Origin`. The
// hardening rules are ABOUT those two headers, so the probe has to speak the
// wire protocol directly. `setHeader`-level control is exactly what an attacker
// on another local process has, which is the threat model being tested.

type ProbeResult = { status: number | null; error?: string };

function probe(
  port: number,
  headers: Record<string, string>,
  path = '/',
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        // Drain, or the socket lingers and the process will not exit cleanly —
        // which assertion (f) would then catch as a hang.
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? null }));
      },
    );
    req.on('error', (err) => resolve({ status: null, error: err.message }));
    req.setTimeout(10_000, () => {
      req.destroy(new Error('probe timeout'));
    });
    req.end();
  });
}

/** First non-internal IPv4 address, i.e. how the rest of the LAN sees us. */
function lanAddress(): string | null {
  for (const iface of Object.values(networkInterfaces())) {
    for (const alias of iface ?? []) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return null;
}

/** Resolves to the connection outcome; a REFUSAL is the passing result. */
function tryConnect(host: string, port: number, timeoutMs = 4000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (r: ProbeResult): void => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done({ status: null, error: 'ETIMEDOUT' }));
    socket.on('connect', () => done({ status: 200 }));
    socket.on('error', (err: NodeJS.ErrnoException) =>
      done({ status: null, error: err.code ?? err.message }),
    );
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  await app.whenReady();

  const bootResult = await boot({ log: () => {} });
  const { server, token } = bootResult;

  // -- (a) the server booted, and the port came off the BOUND HANDLE --------
  // `address` and `port` are both read from `server.address()` in
  // next-server.ts. Reporting them together is what lets the driver check that
  // the port is a kernel-assigned ephemeral one and not a hardcoded guess.
  emit('server', {
    port: server.port,
    address: server.address,
    origin: server.origin,
  });

  // -- (c) hardening ------------------------------------------------------
  // Run BEFORE the window loads, so the probes cannot be confused with the
  // window's own (legitimate) traffic.
  const goodHost = `127.0.0.1:${server.port}`;
  const goodOrigin = `http://127.0.0.1:${server.port}`;

  emit('harden', {
    case: 'foreign-host',
    expect: 403,
    ...(await probe(server.port, {
      // A DNS-rebinding request arrives on loopback but still carries the
      // attacker's hostname. This is the exact shape control §5.1 stops.
      host: 'evil.example.com',
      [TOKEN_HEADER]: token,
    })),
  });

  emit('harden', {
    case: 'foreign-origin',
    expect: 403,
    ...(await probe(server.port, {
      host: goodHost,
      origin: 'http://evil.example.com',
      [TOKEN_HEADER]: token,
    })),
  });

  emit('harden', {
    case: 'no-token',
    expect: 403,
    ...(await probe(server.port, { host: goodHost, origin: goodOrigin })),
  });

  emit('harden', {
    case: 'bad-token',
    expect: 403,
    ...(await probe(server.port, {
      host: goodHost,
      origin: goodOrigin,
      [TOKEN_HEADER]: 'f'.repeat(token.length),
    })),
  });

  emit('harden', {
    case: 'all-correct',
    expect: 200,
    ...(await probe(server.port, {
      host: goodHost,
      origin: goodOrigin,
      [TOKEN_HEADER]: token,
    })),
  });

  // -- (d) loopback only ---------------------------------------------------
  // The definitive test is a connection attempt from the machine's own LAN
  // address: if the listener were on 0.0.0.0 this would connect. A refusal
  // (ECONNREFUSED) is the pass. `boundAddress` is reported alongside so the
  // driver can still assert something meaningful on a host with no LAN
  // interface at all.
  const lan = lanAddress();
  emit('loopback', {
    boundAddress: server.address,
    lanAddress: lan,
    ...(lan ? await tryConnect(lan, server.port) : { status: null, error: 'no-lan-interface' }),
  });

  // -- (e) node:sqlite in the Electron main process ------------------------
  // The open question sqlite-store.ts flags in writing: `node:sqlite` is built
  // into Node 24, but Electron ships its own Node build and could compile out
  // or lag a built-in. This is the check that closes it.
  let sqlite: Record<string, unknown>;
  // Hoisted so assertion (f) can prove the SAME handle is unusable after
  // shutdown, rather than reporting a hardcoded `true`.
  let openedStore: Store | undefined;
  try {
    const store = await bootResult.openStore();
    openedStore = store;
    const ref = store.createSession('spike-04', 'SPIKE-04 session');
    store.appendMessage(ref.sessionId, { role: 'user', content: 'spike-04 round trip' });
    store.setMemory(ref.sessionId, 'spike', '04');
    const messages = store.getMessages(ref.sessionId);
    const dbPath = process.env.NABY_DB_PATH ?? '';
    sqlite = {
      ok: true,
      sessionId: ref.sessionId,
      messageCount: messages.length,
      dbPath,
      dbExists: existsSync(dbPath),
      dbBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
      userDataDir: bootResult.userDataDir,
      underUserData: dbPath.startsWith(bootResult.userDataDir),
    };
  } catch (err) {
    sqlite = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  emit('sqlite', sqlite);

  // -- (b) the window loads ------------------------------------------------
  const win = createMainWindow(bootResult, { show: false });

  let mainFrameFailure: { code: number; description: string } | null = null;
  win.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (isMainFrame) mainFrameFailure = { code, description };
  });

  // `did-navigate` carries the main frame's HTTP status. `did-finish-load` alone
  // is not enough: it also fires for a 500 error page, which is a load but not a
  // success.
  let httpStatus: number | null = null;
  win.webContents.on('did-navigate', (_e, _url, code) => {
    httpStatus = code;
  });

  // Listeners are attached BEFORE the navigation starts, or a fast load could
  // finish before anything is listening and the spike would report a false
  // negative.
  const loaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 90_000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  // The token rides this first navigation; the guard converts it to an HttpOnly
  // cookie, so every subresource the page then requests authenticates itself.
  // That is the real assertion here — a page that loads but whose assets 403
  // would be a broken app, and it would show up as a failed load.
  await win.loadURL(bootResult.windowUrl('/'));

  const finished = await loaded;

  emit('window', {
    finished,
    httpStatus,
    mainFrameFailure,
    url: win.webContents.getURL().split('?')[0],
  });

  // -- (g) the renderer can actually talk to the server --------------------
  //
  // `did-finish-load` is necessary but NOT sufficient: a page whose every
  // subresource and API call got a 403 still finishes loading. Control §5.4 is
  // only really proven if the page's OWN traffic authenticates, so both carriers
  // are exercised from inside the sandboxed renderer:
  //
  //   * plain `fetch` → relies on the HttpOnly cookie the guard set during the
  //     first navigation. This is the path Next's own RSC/asset traffic uses.
  //   * `window.naby.fetch` → the preload bridge attaching the token header
  //     explicitly. This also proves contextBridge exposed what it should.
  //
  // And it confirms the renderer did NOT get anything it shouldn't: `require`
  // and `process` must both be absent under contextIsolation + sandbox.
  const bridge = (await win.webContents.executeJavaScript(
    `(async () => {
       const naby = window.naby;
       const out = {
         bridgePresent: !!naby,
         tokenLength: naby && typeof naby.sessionToken === 'string' ? naby.sessionToken.length : 0,
         nodeLeaked: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
         cookieFetchStatus: null,
         bridgeFetchStatus: null,
         error: null,
       };
       try {
         out.cookieFetchStatus = (await fetch('/api/health', { credentials: 'same-origin' })).status;
         out.bridgeFetchStatus = (await naby.fetch('/api/health')).status;
       } catch (e) { out.error = String(e && e.message ? e.message : e); }
       return out;
     })()`,
  )) as Record<string, unknown>;
  emit('bridge', bridge);

  // -- (f) clean teardown --------------------------------------------------
  win.destroy();

  // Observe the teardown rather than asserting it: shutdown() closes the store
  // and the server, so prove each one independently instead of reporting a
  // hardcoded `true`. A store that is genuinely closed rejects further use.
  //
  // shutdown() is RACED against a timeout rather than simply awaited. It was
  // observed not to resolve on roughly one run in five — and because the emit
  // below sits after it, the whole observation went missing and the driver saw
  // `undefined`, i.e. a flaky-looking FAIL with no evidence. An assertion must
  // either pass or fail with evidence; it must never vanish. If shutdown does
  // stall, the independent checks below still run and `shutdownStalled` says so,
  // which turns a mystery into a finding.
  const shutdownStalled = await Promise.race([
    bootResult.shutdown().then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10_000)),
  ]);

  let storeClosed: boolean;
  if (!openedStore) {
    storeClosed = false; // (e) failed to open one — nothing was proven here.
  } else {
    try {
      // Any query against a closed DatabaseSync throws. If this SUCCEEDS the
      // store is still open and the assertion must fail.
      openedStore.listSessions();
      storeClosed = false;
    } catch {
      storeClosed = true;
    }
  }

  // The listener is gone only if the port genuinely refuses a connection.
  const serverClosed = await new Promise<boolean>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port: bootResult.server.port });
    const done = (closed: boolean) => {
      sock.destroy();
      resolve(closed);
    };
    sock.once('connect', () => done(false)); // still accepting → NOT closed
    sock.once('error', () => done(true)); // ECONNREFUSED → closed
    sock.setTimeout(2000, () => done(false));
  });

  emit('shutdown', { storeClosed, serverClosed, shutdownStalled });

  // stdout is a pipe here, so writes are asynchronous. `app.exit()` terminates
  // without flushing, which silently drops this last event and made assertion
  // (f) report `undefined` even on a clean teardown. Wait for the flush, then
  // exit.
  //
  // The guard must wait on a WRITE CALLBACK, not on the return value of
  // `write('')`. `write()` returns false only when the internal buffer exceeds
  // highWaterMark (64 KiB for a pipe); the `emit('shutdown', …)` line above is
  // ~60 bytes, so it sits queued-but-under-watermark and `write('')` returns
  // TRUE — we resolved immediately and exited before the kernel took the data,
  // losing the event. That made assertion (f) report `storeClosed=undefined`
  // intermittently (~1 run in 3) even though teardown was clean. The callback
  // form fires only once the write has actually been handed off, which is the
  // condition we actually need. Same fix as shell/bin/cock.mjs's flushAndExit.
  //
  // `app.exit(0)` rather than `app.quit()`: quit runs the `before-quit` handler,
  // which belongs to main.ts and is not loaded here. Teardown has already been
  // done explicitly above, so exiting directly is both correct and the thing
  // that makes a HANG (assertion f) detectable rather than masked by a forced
  // kill in the driver.
  // No flush guard needed: emit() is writeSync to fd 1, so every observation
  // is already in the kernel before we get here.
  app.exit(0);
}

run().catch((err: unknown) => {
  emit('fatal', { error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  app.exit(1);
});
