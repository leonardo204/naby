// electron/spike-f110-entry.ts
//
// SPIKE-F110's payload — the code that runs INSIDE the Electron main process.
//
// It proves the three UI claims of this change set against the REAL DOM of a
// REAL boot, because all three are claims about what a user sees and none of
// them can be established by reading a diff:
//
//   1. every tab has a close button, it is REVEALED BY HOVER, and closing the
//      last one lands on the home screen
//   2. the window title is `Naby (Alpha version)…`
//   3. the Claude login indicator renders and agrees with reality
//   4. the chat stream's WebSocket channel is dispatched and answers a
//      same-origin handshake (the regression guard for the silent chat break)
//
// Same shape as spike-entry.ts / spike-f104-entry.ts: exercise the real path,
// emit NDJSON observations, decide nothing. The driver
// (`src/spikes/spike-f110-ui.ts`) turns observations into assertions, so a probe
// that silently fails to run is a FAIL rather than an assertion that quietly
// never executed.
//
// HOVER IS DISPATCHED AS A REAL MOUSE EVENT, not simulated. The close button is
// hidden with Tailwind's `opacity-0 group-hover:opacity-100`, which is CSS
// `:hover` — a synthetic `new MouseEvent('mouseover')` does NOT set it, so a
// JS-only test would read opacity 0 on a perfectly working button (or, worse,
// pass by only checking the class list). `webContents.sendInputEvent` goes
// through Chromium's real input pipeline and moves the real cursor state, so
// `getComputedStyle().opacity` afterwards is the honest answer.
//
// ISOLATION: both `userData` AND `COCKPIT_HOME` are redirected to temp dirs
// before anything boots, and the "project" the spike opens is itself a temp
// directory. The developer's real ~/.cockpit project list, sessions and
// credential vault are never read or written.

import { app } from 'electron';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, createMainWindow } from './boot.js';

const MARK = '##SPIKEF110##';

function emit(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${MARK}${JSON.stringify({ event, ...data })}\n`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Before `app.whenReady()`, or `userData` is already resolved and the redirect
// is a no-op.
const tempUserData = mkdtempSync(join(tmpdir(), 'naby-f110-ud-'));
app.setPath('userData', tempUserData);

// The shell's ENTIRE data root. Read at module load inside the Next server
// (packages/shared/utils/src/paths.ts), so it must be set before boot() starts
// that server — not merely before the first request.
const tempCockpitHome = mkdtempSync(join(tmpdir(), 'naby-f110-home-'));
process.env.COCKPIT_HOME = tempCockpitHome;

// The "project" the window opens. A real directory, because the shell stats it;
// empty, because nothing here reads its contents.
const tempProject = mkdtempSync(join(tmpdir(), 'naby-f110-proj-'));
// A recognisable basename is what assertion (b) checks appears in the title
// AFTER the product name — the whole point of the title format.
const projectName = 'naby-f110-project';
const projectDir = join(tempProject, projectName);
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'README.md'), '# spike f110\n');

/** How long any single "wait for the DOM to settle" poll may take. */
const DOM_TIMEOUT_MS = 40_000;

// ---------------------------------------------------------------------------
// Recents fixture (assertions j / k / l)
// ---------------------------------------------------------------------------

/** Mirrors `encodePath` in @cockpit/shared-utils — the session directory name
 *  for a cwd. Duplicated rather than imported so this file stays free of the
 *  shell's module graph, exactly as EXPECTED_TITLE is duplicated in the driver. */
const encodePath = (p: string): string => p.replace(/[/.]/g, '-');

/**
 * A REAL past session for the opened project, written into the temp
 * COCKPIT_HOME (`ollama-sessions/<encoded-cwd>/`) — one of the four session
 * sources the sessions API reads. It exists so assertion (l) can prove that
 * removing a project from the list leaves its history intact: without a
 * session there would be nothing to leave intact, and the assertion would pass
 * vacuously. Nothing is written under the developer's real ~/.claude.
 */
const SESSION_FIXTURE_TEXT = 'spike f110 recents fixture message';
const sessionDirFor = (cwd: string): string =>
  join(process.env.COCKPIT_HOME ?? '', 'ollama-sessions', encodePath(cwd));

function seedSessionHistory(cwd: string): string {
  const dir = sessionDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'f110-recents-fixture.jsonl');
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'summary', summary: 'F110 recents fixture session' })}\n` +
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: SESSION_FIXTURE_TEXT } })}\n`,
  );
  return file;
}

/**
 * 24 real, empty directories recorded as already-opened projects.
 *
 * WHY: assertion (c2) requires the home screen's list to actually OVERFLOW and
 * scroll. Before this change the list was the machine-wide scan of
 * ~/.claude/projects, so on any real machine it overflowed by accident; now the
 * list is only what the user opened, and a one-item list cannot exercise the
 * scroll bug (c2) exists to catch. So the fixture supplies the length.
 *
 * `activeIndex: -1` is deliberate: no seeded project may mount an iframe. Every
 * pre-existing assertion here reads `document.querySelector('iframe')` — the
 * first one in the DOM — and expects it to be the project the spike opened. One
 * mounted iframe in, one mounted iframe out.
 *
 * Written through the app's own store file (~/.cockpit/projects.json in the
 * TEMP home) and read back through /api/projects, so the list still arrives the
 * way the app loads it.
 */
function seedRecents(parent: string, count: number): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const dir = join(parent, `f110-seed-${i}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
  }
  const now = Date.now();
  writeFileSync(
    join(process.env.COCKPIT_HOME ?? '', 'projects.json'),
    JSON.stringify({
      // Staggered into the past, so the project the spike opens must sort to
      // the top on its own merits rather than by luck of insertion order.
      projects: dirs.map((cwd, i) => ({ cwd, lastOpenedAt: now - (i + 1) * 3_600_000 })),
      activeIndex: -1,
      collapsed: false,
    }),
  );
  return dirs;
}

async function run(): Promise<void> {
  await app.whenReady();

  const bootResult = await boot({ log: (msg) => emit('log', { msg }) });

  // SHOWN, unlike the other spikes' hidden windows, and that is load-bearing:
  // assertion (b) dispatches a real mouse move to trigger CSS `:hover`, and
  // Chromium does not run hit-testing or update hover state for a window that
  // was never shown — the probe read opacity 0 on a button that works. Shown
  // WITHOUT focus so a spike run does not steal the developer's keyboard.
  const win = createMainWindow(bootResult, { show: false });
  win.showInactive();

  /** A full page load, awaited to `did-finish-load`. Used for the initial boot
   *  and for the reload assertions in (k)/(l), where "survives a reload" must
   *  mean a real navigation that re-reads the persisted list from the server. */
  const load = async (path: string): Promise<boolean> => {
    const finished = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 90_000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    await win.loadURL(bootResult.windowUrl(path));
    return finished;
  };

  // -------------------------------------------------------------------------
  // (j) A FRESH PROFILE'S HOME SCREEN IS EMPTY — not a scan of the machine.
  // -------------------------------------------------------------------------
  //
  // Observed FIRST, before anything is opened, because "fresh" is a state this
  // spike destroys the moment it opens a project. COCKPIT_HOME is a temp dir,
  // so the app's own record of opened projects is empty — but HOME is the
  // developer's real one, so ~/.claude/projects still holds every directory
  // they have ever run Claude Code in. That gap IS the assertion: the scan
  // returns many, the home screen must show none.
  //
  // Only COUNTS cross the observation boundary. The paths in that scan are the
  // developer's machine layout and have no business in a log.
  const freshLoaded = await load('/');
  const fresh = (await win.webContents.executeJavaScript(
    `(async () => {
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const home = () => document.querySelector('[data-testid="home-screen"]');
       while (Date.now() < deadline && !home()) {
         await new Promise((r) => setTimeout(r, 200));
       }
       const el = home();
       if (!el) return { homeVisible: false };
       // The machine-wide session scan — the list the home screen used to be.
       let scan = [];
       try { scan = await (await fetch('/api/sessions/projects')).json(); } catch { scan = []; }
       const paths = Array.isArray(scan) ? scan.map((p) => String(p.fullPath || '')).filter(Boolean) : [];
       const text = el.innerText || '';
       const openBtn = document.querySelectorAll('[data-testid="home-open-project"]');
       const createBtn = document.querySelectorAll('[data-testid="home-create-project"]');
       const emptyPanel = document.querySelector('[data-testid="home-empty-recents"]');
       return {
         homeVisible: true,
         rows: document.querySelectorAll('[data-testid="recent-project"]').length,
         emptyStateShown: !!emptyPanel,
         // A blank panel is not an acceptable empty state: it has to say
         // something and offer both ways in.
         emptyStateWords: emptyPanel ? (emptyPanel.innerText || '').trim().split(/\\s+/).length : 0,
         openAffordances: openBtn.length,
         createAffordances: createBtn.length,
         openLabel: openBtn[0] ? (openBtn[0].innerText || '').trim() : '',
         // How many projects a disk scan WOULD have offered, and how many of
         // their paths actually appear on screen. Counts only.
         machineProjects: paths.length,
         machinePathsOnScreen: paths.filter((p) => text.includes(p)).length,
       };
     })()`,
  )) as Record<string, unknown>;
  emit('fresh', { ...fresh, loaded: freshLoaded });

  // Now the fixture: 24 already-opened projects (so the list can overflow for
  // (c2)) and one real past session for the project about to be opened (so (l)
  // has history to prove it did not destroy).
  const seededDirs = seedRecents(tempProject, 24);
  const sessionFixture = seedSessionHistory(projectDir);
  emit('seeded', { seeded: seededDirs.length, sessionFixture });

  // `?cwd=` is the deterministic way in: Workspace adds the project to its list
  // and mounts its iframe, which is what gives us a tab bar to assert against.
  // Seeding ~/.cockpit/state.json instead would test our seeding, not the app.
  const windowLoaded = await load(`/?cwd=${encodeURIComponent(projectDir)}`);
  emit('window', { finished: windowLoaded, projectDir, projectName });

  // -------------------------------------------------------------------------
  // Wait for the project iframe to exist and its tab bar to render.
  // -------------------------------------------------------------------------
  //
  // Polls for what is ACTUALLY ASSERTED (a tab with a close button), not merely
  // for the iframe element. The iframe appears immediately; its React tree,
  // i18n and tab-state restore land several round trips later, and sampling in
  // between reported "0 tabs" on a UI that was about to be correct — the exact
  // load-dependent flake this repo has already fixed three times elsewhere.
  const ready = (await win.webContents.executeJavaScript(
    `(async () => {
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const iframe = () => document.querySelector('iframe');
       const doc = () => { try { return iframe()?.contentDocument ?? null; } catch { return null; } };
       const tabs = () => Array.from(doc()?.querySelectorAll('[data-testid="tab-close"]') ?? []);
       while (Date.now() < deadline && tabs().length === 0) {
         await new Promise((r) => setTimeout(r, 250));
       }
       return { iframePresent: !!iframe(), tabCloseButtons: tabs().length };
     })()`,
  )) as Record<string, unknown>;
  emit('ready', ready);

  // -------------------------------------------------------------------------
  // (i) The chat stream's WebSocket channel is actually dispatched.
  // -------------------------------------------------------------------------
  //
  // REGRESSION GUARD for a bug that broke chat while leaving every visible
  // surface working. `next-server.ts` handed WS upgrades straight to Next's own
  // upgrade handler and never to the SHELL's route dispatcher, so
  // `/ws/session-stream` reached nobody. Next does not refuse an unknown
  // upgrade path — it leaves the socket OPEN AND UNANSWERED — so the client got
  // no `open`, no `close` and no error, the server logged nothing, and the only
  // symptom was useChatStream's 15-second watchdog eventually writing "An error
  // occurred, please retry" into the bubble. Sidebar, projects, engine toggle
  // and sign-in status all still worked, which is what made it so hard to see.
  //
  // WHY THIS AND NOT "SEND A CHAT MESSAGE": a real turn needs a signed-in Claude
  // and costs money and minutes, so it cannot run in `spike:nokeys`. The
  // handshake is the exact thing that was broken and it is free and
  // deterministic, so THAT is what is asserted. `HANGS` is a distinct outcome
  // from `close` here on purpose — the old behaviour produced neither an open
  // nor a close, and an assertion that only checked "did not receive data"
  // would have passed on a socket that was refused outright.
  //
  // The socket is opened from the PAGE, with no cooperation from the preload
  // bridge, so it authenticates exactly as the chat client does: the HttpOnly
  // token cookie riding a same-origin handshake. It therefore also proves the
  // hardened upgrade path ACCEPTS the legitimate case — the complement to
  // SPIKE-04's four refusals, which stay unchanged.
  const wsStream = (await win.webContents.executeJavaScript(
    `(async () => {
       const url = location.origin.replace('http', 'ws') + '/ws/session-stream?sessionId=spike-f110-probe';
       return await new Promise((resolve) => {
         let opened = false;
         const sock = new WebSocket(url);
         const done = (outcome, extra) => resolve({ url, outcome, opened, ...extra });
         // Comfortably longer than a loopback handshake, and shorter than the
         // driver's run timeout so a hang reports as a hang, not as a dead spike.
         const timer = setTimeout(() => done('hung', {}), 20000);
         sock.onopen = () => { opened = true; };
         sock.onmessage = (e) => {
           clearTimeout(timer);
           let type = null;
           try { type = JSON.parse(String(e.data)).type ?? null; } catch { /* non-JSON */ }
           try { sock.close(); } catch { /* already closing */ }
           done('message', { messageType: type, bytes: String(e.data).length });
         };
         sock.onclose = (e) => { clearTimeout(timer); done('closed', { code: e.code, reason: e.reason }); };
       });
     })()`,
  )) as Record<string, unknown>;
  emit('wsStream', wsStream);

  // -------------------------------------------------------------------------
  // Dismiss the first-run wizard.
  // -------------------------------------------------------------------------
  //
  // NOT COSMETIC. This spike runs with a fresh temp `userData`, so the vault is
  // empty and F1-06's onboarding wizard renders as a FULL-SCREEN OVERLAY over
  // the workspace. The DOM assertions below reach past it (they query the
  // iframe's contentDocument directly), but assertion (b) dispatches a REAL
  // mouse event — and a real mouse lands on whatever is actually on top, which
  // was the wizard. That is precisely the value of testing hover for real: a
  // JS-only probe would have reported a pass here.
  //
  // "Skip for now" is the documented non-dead-end exit (see NabyProviderSetup),
  // and skipping is the honest state for this spike: it asserts the chat shell,
  // not provider configuration, which SPIKE-F104 already owns.
  const wizard = (await win.webContents.executeJavaScript(
    `(async () => {
       const deadline = Date.now() + 20000;
       const skip = () => Array.from(document.querySelectorAll('button'))
         .find((b) => (b.textContent || '').includes('Skip for now'));
       while (Date.now() < deadline && !skip()) {
         await new Promise((r) => setTimeout(r, 250));
       }
       const btn = skip();
       if (!btn) return { wizardSeen: false, dismissed: false };
       btn.click();
       const gone = Date.now() + 15000;
       while (Date.now() < gone && skip()) {
         await new Promise((r) => setTimeout(r, 200));
       }
       return { wizardSeen: true, dismissed: !skip() };
     })()`,
  )) as Record<string, unknown>;
  emit('wizard', wizard);

  // -------------------------------------------------------------------------
  // (b) The window title.
  // -------------------------------------------------------------------------
  //
  // Three sources, because they are three separate mechanisms that have each
  // been wrong at some point: the SSR metadata (`generateMetadata`), the
  // client-side `document.title` Workspace sets on every project switch, and
  // what the OS window manager actually shows (`BrowserWindow.getTitle()` —
  // the only one a user can see in the dock/task switcher).
  const title = (await win.webContents.executeJavaScript(
    `(async () => {
       // Workspace sets the title from an effect after projects load, so give
       // it the same chance to be right that a user would.
       const deadline = Date.now() + 15000;
       while (Date.now() < deadline && !document.title.includes('Naby')) {
         await new Promise((r) => setTimeout(r, 200));
       }
       const iframeDoc = (() => { try { return document.querySelector('iframe')?.contentDocument ?? null; } catch { return null; } })();
       return { documentTitle: document.title, iframeTitle: iframeDoc ? iframeDoc.title : null };
     })()`,
  )) as Record<string, unknown>;
  emit('title', { ...title, windowTitle: win.getTitle() });

  // -------------------------------------------------------------------------
  // (d) The Claude login indicator, and what the truth actually is.
  // -------------------------------------------------------------------------
  //
  // The DOM reading is taken FIRST and the runtime's own answer SECOND, then
  // the driver compares them. Asserting only "a dot rendered" would pass on an
  // indicator hard-coded to green; asserting only the runtime function would
  // never touch the UI. The claim is that the UI reflects the real state, so
  // both halves are observed and the comparison is the assertion.
  const loginDom = (await win.webContents.executeJavaScript(
    `(async () => {
       const doc = (() => { try { return document.querySelector('iframe')?.contentDocument ?? null; } catch { return null; } })();
       if (!doc) return { docPresent: false };
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const el = () => doc.querySelector('[data-testid="claude-login-status"]');
       while (Date.now() < deadline && !el()) {
         await new Promise((r) => setTimeout(r, 250));
       }
       const node = el();
       if (!node) return { docPresent: true, present: false };
       const dot = doc.querySelector('[data-testid="claude-login-dot"]');
       const remedy = doc.querySelector('[data-testid="claude-login-remedy"]');
       // The execution-mode toggle is the anchor the indicator is supposed to
       // sit beside; proving adjacency is what makes "surfaced where the engine
       // choice is visible" a real claim rather than "rendered somewhere".
       const toggle = doc.querySelector('[data-testid="chatmode-toggle"]');
       return {
         docPresent: true,
         present: true,
         status: node.getAttribute('data-status'),
         text: node.innerText,
         tooltip: node.getAttribute('title') || '',
         dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
         remedyShown: !!remedy,
         remedyText: remedy ? remedy.innerText : '',
         // Same parent row as the SDK/CLI toggle.
         besideEngineToggle: !!toggle && !!node.parentElement && node.parentElement === toggle.parentElement,
       };
     })()`,
  )) as Record<string, unknown>;

  // The runtime's answer, from the process that owns it. Deliberately NOT read
  // through /api/naby — that is the same path the UI used, so agreeing with it
  // would prove only that one fetch happened twice.
  const runtime = (await bootResult.loadRuntime()) as unknown as {
    checkClaudeLogin: () => { status: string; cliFound: boolean; remedy: string | null };
    resetClaudeLoginCache: () => void;
  };
  // The Next server runs IN THIS PROCESS, and both it and this call resolve the
  // runtime to the same file URL — so Node's module cache makes them the same
  // instance, and clearing the cache here clears the one /api/naby reads.
  // (If that ever stopped being true, assertion (g) would fail rather than
  // silently assert nothing: the UI would keep reporting the stale status.)
  runtime.resetClaudeLoginCache();
  const truth = runtime.checkClaudeLogin();
  emit('login', {
    dom: loginDom,
    truthStatus: truth.status,
    truthCliFound: truth.cliFound,
    truthHasRemedy: truth.remedy !== null,
  });

  // -------------------------------------------------------------------------
  // (g) The SIGNED-OUT branch — the case the feature exists for.
  // -------------------------------------------------------------------------
  //
  // A green dot on a machine that is signed in proves the happy path only. The
  // requirement is that a LOGGED-OUT machine is told so, and told what to do,
  // instead of failing at send time — so the signed-out state is produced for
  // real and the UI is watched to follow it.
  //
  // Produced by pointing `CLAUDE_CONFIG_DIR` at an empty directory, which is the
  // same switch Claude Code itself honours. Nothing is deleted, moved, or read:
  // the developer's real `~/.claude/.credentials.json` is simply not where the
  // check looks any more. The variable is restored afterwards.
  //
  // The refresh is driven by dispatching `focus` at the iframe's window — the
  // component's own re-check trigger — rather than by reloading the page. That
  // makes this an assertion about the TRIGGER as well as the indicator: a
  // status that only updated on reload would fail here.
  const emptyClaudeDir = mkdtempSync(join(tmpdir(), 'naby-f110-noclaude-'));
  const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = emptyClaudeDir;
  runtime.resetClaudeLoginCache();

  const signedOut = (await win.webContents.executeJavaScript(
    `(async () => {
       const iframe = document.querySelector('iframe');
       const doc = (() => { try { return iframe?.contentDocument ?? null; } catch { return null; } })();
       if (!doc || !iframe.contentWindow) return { docPresent: false };
       const el = () => doc.querySelector('[data-testid="claude-login-status"]');
       // Poke the re-check trigger until the status follows, or we give up.
       // The runtime caches for 10s, so the first few pokes legitimately return
       // the stale (correct-at-the-time) answer — this waits that out rather
       // than racing it.
       const deadline = Date.now() + 40000;
       while (Date.now() < deadline && el()?.getAttribute('data-status') !== 'signed-out') {
         iframe.contentWindow.dispatchEvent(new Event('focus'));
         await new Promise((r) => setTimeout(r, 1000));
       }
       const node = el();
       const remedy = doc.querySelector('[data-testid="claude-login-remedy"]');
       const recheck = doc.querySelector('[data-testid="claude-login-recheck"]');
       const dot = doc.querySelector('[data-testid="claude-login-dot"]');
       return {
         docPresent: true,
         status: node ? node.getAttribute('data-status') : null,
         text: node ? node.innerText : '',
         tooltip: node ? (node.getAttribute('title') || '') : '',
         dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
         // The two things a signed-out user needs: what to run, and a way to
         // tell the app they have run it.
         remedyShown: !!remedy,
         remedyText: remedy ? remedy.innerText : '',
         recheckOffered: !!recheck,
         // Nothing is BLOCKED by being signed out — the composer stays usable.
         // A status heuristic that can lock the user out of their own app is
         // worse than one that lets a send fail with a clear error.
         composerDisabled: (() => {
           const ta = doc.querySelector('textarea');
           return ta ? ta.disabled : null;
         })(),
       };
     })()`,
  )) as Record<string, unknown>;

  const truthSignedOut = runtime.checkClaudeLogin();
  emit('signedOut', {
    dom: signedOut,
    truthStatus: truthSignedOut.status,
    truthRemedy: truthSignedOut.remedy ?? '',
  });

  // Put the environment back before anything else observes it.
  if (realClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeConfigDir;
  runtime.resetClaudeLoginCache();
  try {
    rmSync(emptyClaudeDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  // -------------------------------------------------------------------------
  // (e) No upstream branding left on screen.
  // -------------------------------------------------------------------------
  //
  // Scans the RENDERED TEXT of both documents rather than the source, so it
  // catches a string that arrives from i18n, from an API response, or from a
  // component nobody thought to grep.
  const branding = (await win.webContents.executeJavaScript(
    `(() => {
       const doc = (() => { try { return document.querySelector('iframe')?.contentDocument ?? null; } catch { return null; } })();
       const parentText = document.body.innerText || '';
       const iframeText = doc ? (doc.body.innerText || '') : '';
       const hits = (t) => (t.match(/OpenCockpit|Cockpit/g) || []);
       return {
         parentHits: hits(parentText),
         iframeHits: hits(iframeText),
         // Where the product name is actually READABLE in this view. The chat
         // panel hides ChatHeader (TabManager owns the chrome), so the default
         // screen has no product wordmark in its body text — the title bar is
         // the surface that carries it, and that is what is checked.
         nabyInTitle: document.title.includes('Naby'),
         nabyInParentText: parentText.includes('Naby'),
       };
     })()`,
  )) as Record<string, unknown>;
  emit('branding', branding);

  // -------------------------------------------------------------------------
  // (a1) The close button on the LAST remaining tab — revealed by real hover.
  // -------------------------------------------------------------------------
  //
  // First reduce to exactly one tab, so "the last tab" is literal rather than
  // approximated. Extra tabs are closed through the same close button a user
  // clicks; if that did not work the count would not reach 1 and the assertion
  // fails for the right reason.
  const reduced = (await win.webContents.executeJavaScript(
    `(async () => {
       const doc = (() => { try { return document.querySelector('iframe')?.contentDocument ?? null; } catch { return null; } })();
       if (!doc) return { docPresent: false };
       const btns = () => Array.from(doc.querySelectorAll('[data-testid="tab-close"]'));
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       while (Date.now() < deadline && btns().length > 1) {
         btns()[btns().length - 1].click();
         await new Promise((r) => setTimeout(r, 300));
       }
       return { docPresent: true, tabCount: btns().length };
     })()`,
  )) as Record<string, unknown>;
  emit('reduced', reduced);

  // Opacity BEFORE hover, plus the on-screen rectangle to aim the cursor at.
  const preHover = (await win.webContents.executeJavaScript(
    `(() => {
       const iframe = document.querySelector('iframe');
       const doc = (() => { try { return iframe?.contentDocument ?? null; } catch { return null; } })();
       const btn = doc?.querySelector('[data-testid="tab-close"]');
       if (!iframe || !btn) return { found: false };
       const fr = iframe.getBoundingClientRect();
       const br = btn.getBoundingClientRect();
       // Aim at the TAB's centre, not the button's. Hovering the button would
       // also satisfy the CSS rule, but the CLAIM is "hovering a tab reveals
       // the ×" — so the cursor goes where the claim says it goes, and a rule
       // that only fired on the button itself would (correctly) fail.
       const tab = btn.closest('.group');
       const tr = tab ? tab.getBoundingClientRect() : br;
       return {
         found: true,
         opacity: getComputedStyle(btn).opacity,
         // Class list is reported too, so the driver can distinguish "hidden by
         // the hover rule" from "hidden by something else entirely".
         className: btn.className,
         // Iframe-relative rects plus the iframe's own offset in the parent —
         // sendInputEvent takes coordinates in the WINDOW's space.
         tabX: Math.round(fr.left + tr.left + tr.width / 2),
         tabY: Math.round(fr.top + tr.top + tr.height / 2),
         iframeRect: [fr.left, fr.top, fr.width, fr.height].map(Math.round).join(','),
         tabRect: [tr.left, tr.top, tr.width, tr.height].map(Math.round).join(','),
       };
     })()`,
  )) as Record<string, unknown>;

  // A REAL mouse move through Chromium's input pipeline — this is what sets
  // CSS `:hover`. A synthetic `new MouseEvent('mouseover')` dispatched from JS
  // does NOT, which is the whole reason this goes through the input layer.
  //
  // CDP (`Input.dispatchMouseEvent`) rather than `webContents.sendInputEvent`:
  // sendInputEvent delivers to the top-level widget, and the tab bar lives in
  // an out-of-process iframe, so the move never reached it and hover state
  // never updated (observed: `tabMatchesHover=false` on a working button). CDP
  // dispatches through the browser's input router, which owns OOPIF hit-testing
  // and routes the event to the correct renderer.
  //
  // TWO MOVES, not one: Chromium coalesces a move to the position it already
  // believes the cursor occupies, and on a freshly shown window that is (0,0) —
  // so a single move to a target that happens to be the current position is a
  // no-op. The first move guarantees the second is a genuine transition.
  let hoverDispatch = 'skipped';
  if (preHover.found) {
    try {
      // No `Input.enable` — the Input domain has no enable command (attempting
      // it fails the whole attach with "'Input.enable' wasn't found").
      // `dispatchMouseEvent` works on a bare attached session.
      win.webContents.debugger.attach('1.3');
      const move = (x: number, y: number) =>
        win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          buttons: 0,
          clickCount: 0,
          pointerType: 'mouse',
        });
      await move(5, 5);
      await new Promise((r) => setTimeout(r, 150));
      await move(preHover.tabX as number, preHover.tabY as number);
      await new Promise((r) => setTimeout(r, 500));
      hoverDispatch = 'cdp';
    } catch (err) {
      hoverDispatch = `cdp-failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const postHover = (await win.webContents.executeJavaScript(
    `(() => {
       const doc = (() => { try { return document.querySelector('iframe')?.contentDocument ?? null; } catch { return null; } })();
       const btn = doc?.querySelector('[data-testid="tab-close"]');
       const at = document.elementFromPoint(${Number(preHover.tabX ?? 0)}, ${Number(preHover.tabY ?? 0)});
       const diag = {
         parentHoverCount: document.querySelectorAll(':hover').length,
         parentHoverTail: Array.from(document.querySelectorAll(':hover')).slice(-2)
           .map((e) => e.tagName).join('>'),
         elementAtPoint: at ? at.tagName : null,
         viewport: window.innerWidth + 'x' + window.innerHeight,
       };
       if (!btn) return { found: false, ...diag };
       const tab = btn.closest('.group');
       return {
         found: true,
         opacity: getComputedStyle(btn).opacity,
         // Independent confirmation that the cursor really is over the tab,
         // so an opacity reading of 1 cannot be explained by "hover never
         // happened and the button was always visible".
         tabHovered: !!tab && tab.matches(':hover'),
         // Diagnostic for the case where hover did NOT take: says whether the
         // event was mis-aimed (nothing hovered in the iframe at all) or
         // delivered somewhere unexpected.
         hoveredInIframe: (doc.querySelectorAll(':hover').length),
         hoveredTail: Array.from(doc.querySelectorAll(':hover')).slice(-3)
           .map((e) => e.tagName + '.' + String(e.className).split(' ')[0]).join(' > '),
         visibleRect: btn.getBoundingClientRect().width > 0,
         ...diag,
       };
     })()`,
  )) as Record<string, unknown>;
  emit('hover', { pre: preHover, post: postHover, dispatch: hoverDispatch });
  try {
    win.webContents.debugger.detach();
  } catch {
    /* never attached, or already gone */
  }

  // -------------------------------------------------------------------------
  // (a2) Closing that last tab lands on the home screen.
  // -------------------------------------------------------------------------
  //
  // Asserted in the PARENT document, because the home screen is a parent-window
  // view — the whole reason the iframe has to ask rather than navigate itself.
  // The iframe's own tab bar is checked too: it must have re-seeded a blank tab
  // rather than been left as an empty shell.
  const home = (await win.webContents.executeJavaScript(
    `(async () => {
       const doc = (() => { try { return document.querySelector('iframe')?.contentDocument ?? null; } catch { return null; } })();
       if (!doc) return { docPresent: false };
       const btn = doc.querySelector('[data-testid="tab-close"]');
       if (!btn) return { docPresent: true, clicked: false };
       const titleBefore = document.title;
       btn.click();
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const homeEl = () => document.querySelector('[data-testid="home-screen"]');
       while (Date.now() < deadline && !homeEl()) {
         await new Promise((r) => setTimeout(r, 200));
       }
       const iframe = document.querySelector('iframe');
       const doc2 = (() => { try { return iframe?.contentDocument ?? null; } catch { return null; } })();
       return {
         docPresent: true,
         clicked: true,
         titleBefore,
         homeVisible: !!homeEl(),
         // The home screen must be VISIBLE, not merely mounted behind the
         // project view — an assertion on presence alone would pass on a
         // completely broken layout.
         homeHasSize: !!homeEl() && homeEl().getBoundingClientRect().height > 100,
         // The project iframes stay MOUNTED (going home is a navigation, not a
         // reset) but their container must be hidden.
         iframeStillMounted: !!iframe,
         iframeContainerHidden: !!iframe && iframe.parentElement.classList.contains('hidden'),
         // Not an empty shell: the iframe re-seeded a blank tab for the user's
         // return.
         iframeTabsAfter: doc2 ? doc2.querySelectorAll('[data-testid="tab-close"]').length : -1,
         titleAfter: document.title,
         // The home screen SCROLLS. A long project list used to overflow the
         // viewport with nothing scrollable, because the root was a flex item
         // with the default min-height:auto — it grew to fit its content, so
         // the inner overflow-y-auto never received a bounded height. Asserting
         // "a scroll container exists" would have passed throughout that bug, so
         // this measures the two things that were actually wrong: the root must
         // be clipped to the viewport, and the scroller must actually move.
         ...(() => {
           const home = homeEl();
           const scroller = home ? home.querySelector('.overflow-y-auto') : null;
           if (!home || !scroller) return { homeScrollProbe: 'no-scroller' };
           const before = scroller.scrollTop;
           scroller.scrollTop = before + 300;
           const moved = scroller.scrollTop > before;
           scroller.scrollTop = before;
           return {
             homeScrollProbe: 'ok',
             homeFitsViewport:
               home.getBoundingClientRect().height <= window.innerHeight + 4,
             scrollerOverflows:
               scroller.scrollHeight > scroller.clientHeight + 4,
             scrollerMoved: moved,
           };
         })(),
       };
     })()`,
  )) as Record<string, unknown>;
  emit('home', home);

  // -------------------------------------------------------------------------
  // (k) OPENING A PROJECT ADDS EXACTLY ONE ENTRY, AND IT SURVIVES A RELOAD.
  // (l) THE × REMOVES IT FROM THE LIST ONLY — NOTHING ON DISK IS TOUCHED.
  // -------------------------------------------------------------------------
  //
  // The home screen is already on screen (the (c) probe closed the last tab to
  // get here), and the list should now be the 24 seeded projects plus the ONE
  // this run opened, sorted most-recent-first — so the opened one is at the top.
  const exec = (js: string) => win.webContents.executeJavaScript(js) as Promise<Record<string, unknown>>;
  const q = JSON.stringify(projectDir);

  /** Get back to the home screen after a reload: the app reopens the project it
   *  had, so reaching home means closing its last tab — the same route a user
   *  takes, and the one (c) already proves works.
   *
   *  THE VISIBLE IFRAME, not the first one in the DOM. By this point the run has
   *  25 projects, and a reload mounts the iframe of the project that was active
   *  when it was saved BEFORE `?cwd=` switches to another — so two iframes can
   *  be mounted at once, the earlier one first in document order. "Close the
   *  last tab" only goes home for the project the user is actually looking at
   *  (Workspace guards GO_HOME on the sender being active), which is precisely
   *  the one with a non-zero box: the others are `display:none`. */
  const goHomeJs = `(async () => {
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const homeEl = () => document.querySelector('[data-testid="home-screen"]');
       const visibleIframe = () =>
         Array.from(document.querySelectorAll('iframe'))
           .find((f) => f.getBoundingClientRect().width > 0) ?? null;
       const doc = () => { try { return visibleIframe()?.contentDocument ?? null; } catch { return null; } };
       const closeBtn = () => (doc() ? doc().querySelector('[data-testid="tab-close"]') : null);
       while (Date.now() < deadline && !homeEl() && !closeBtn()) {
         await new Promise((r) => setTimeout(r, 250));
       }
       if (!homeEl()) {
         const b = closeBtn();
         if (b) b.click();
         while (Date.now() < deadline && !homeEl()) {
           await new Promise((r) => setTimeout(r, 200));
         }
       }
       return { reachedHome: !!homeEl() };
     })()`;

  const recentsJs = `(async () => {
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const rows = () => Array.from(document.querySelectorAll('[data-testid="recent-project"]'));
       while (Date.now() < deadline && rows().length === 0 &&
              !document.querySelector('[data-testid="home-empty-recents"]')) {
         await new Promise((r) => setTimeout(r, 200));
       }
       const all = rows();
       const target = all.filter((r) => r.getAttribute('data-cwd') === ${q});
       const remove = target[0] ? target[0].querySelector('[data-testid="recent-remove"]') : null;
       return {
         homeVisible: !!document.querySelector('[data-testid="home-screen"]'),
         rows: all.length,
         targetRows: target.length,
         // Ordering is the point of storing lastOpenedAt: the project opened
         // most recently must lead a list whose other entries are hours older.
         targetIsFirst: all.length > 0 && all[0].getAttribute('data-cwd') === ${q},
         // The × must SAY that it only touches the list.
         removeTooltip: remove ? (remove.getAttribute('title') || '') : '',
         removalNote: (() => {
           const n = document.querySelector('[data-testid="recents-removal-note"]');
           return n ? (n.innerText || '').trim() : '';
         })(),
       };
     })()`;

  const recentsAfterOpen = await exec(recentsJs);
  emit('recentsAfterOpen', recentsAfterOpen);

  // Survives a reload — a real navigation, so the list comes back from
  // ~/.cockpit/projects.json through /api/projects, not from React state.
  await load('/');
  const home1 = await exec(goHomeJs);
  const recentsAfterReload = await exec(recentsJs);
  emit('recentsAfterReload', { ...recentsAfterReload, ...home1 });

  // The ×.
  const removed = await exec(
    `(async () => {
       const rows = () => Array.from(document.querySelectorAll('[data-testid="recent-project"]'));
       const target = () => document.querySelector('[data-testid="recent-project"][data-cwd=' + ${JSON.stringify(q)} + ']');
       const before = rows().length;
       const btn = document.querySelector('[data-testid="recent-remove"][data-cwd=' + ${JSON.stringify(q)} + ']');
       if (!btn) return { clicked: false, before };
       btn.click();
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       while (Date.now() < deadline && target()) {
         await new Promise((r) => setTimeout(r, 150));
       }
       return {
         clicked: true,
         before,
         after: rows().length,
         targetGone: !target(),
         // Removing one project must not take the others with it, and must not
         // throw the user off the home screen.
         homeStillVisible: !!document.querySelector('[data-testid="home-screen"]'),
       };
     })()`,
  );
  emit('removed', removed);

  await load('/');
  const home2 = await exec(goHomeJs);
  const recentsAfterRemoveReload = await exec(recentsJs);
  emit('recentsAfterRemoveReload', { ...recentsAfterRemoveReload, ...home2 });

  // NOTHING ON DISK MOVED. Checked from the main process (the directory and its
  // contents) and from the app (the session history API still answers for that
  // path), because "removed from the list" has to mean exactly that.
  const sessionsApi = await exec(
    `(async () => {
       try {
         const res = await fetch('/api/sessions/projects/' + encodeURIComponent(${JSON.stringify(encodePath(projectDir))}));
         const body = await res.json();
         return { count: Array.isArray(body) ? body.length : -1 };
       } catch (e) { return { count: -2 }; }
     })()`,
  );
  emit('untouched', {
    dirExists: existsSync(projectDir),
    dirEntries: existsSync(projectDir) ? readdirSync(projectDir).length : -1,
    sessionFileExists: existsSync(sessionFixture),
    sessionsViaApi: sessionsApi.count,
  });

  // Reopen it: the entry comes back AND its past sessions come back with it.
  await load(`/?cwd=${encodeURIComponent(projectDir)}`);
  const home3 = await exec(goHomeJs);
  const reopened = await exec(
    `(async () => {
       const deadline = Date.now() + ${DOM_TIMEOUT_MS};
       const row = () => document.querySelector('[data-testid="recent-project"][data-cwd=' + ${JSON.stringify(q)} + ']');
       while (Date.now() < deadline && !row()) {
         await new Promise((r) => setTimeout(r, 200));
       }
       if (!row()) return { rowBack: false };
       const expand = row().querySelector('[data-testid="recent-expand"]');
       if (expand) expand.click();
       while (Date.now() < deadline &&
              row().querySelectorAll('[data-testid="recent-session"]').length === 0) {
         await new Promise((r) => setTimeout(r, 250));
       }
       return {
         rowBack: true,
         rows: document.querySelectorAll('[data-testid="recent-project"]').length,
         sessions: row().querySelectorAll('[data-testid="recent-session"]').length,
         // The session that existed before the removal, still readable in the UI.
         fixtureVisible: (row().innerText || '').includes(${JSON.stringify(SESSION_FIXTURE_TEXT)}),
       };
     })()`,
  );
  emit('reopened', { ...reopened, ...home3 });

  // -- teardown ------------------------------------------------------------
  //
  // The final observation is emitted and FLUSHED before teardown, for the same
  // reason spike-f104-entry.ts does it: this spike asserts nothing about
  // teardown (SPIKE-04 owns that), so reporting first removes a whole class of
  // false FAIL caused by the quit sequence racing `shutdown()`.
  emit('done', { tempUserData, tempCockpitHome, tempProject });
  await new Promise<void>((resolve) => {
    // Wait on the WRITE CALLBACK, not `write()`'s return value — a short line
    // sits under the pipe's highWaterMark, so `write()` returns true and
    // exiting here would drop the observation the driver waits for.
    process.stdout.write('', 'utf8', () => resolve());
  });

  win.destroy();
  await bootResult.shutdown();
  cleanup();
  app.exit(0);
}

function cleanup(): void {
  for (const dir of [tempUserData, tempCockpitHome, tempProject]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the driver cleans up after exit */
    }
  }
}

run().catch((err: unknown) => {
  emit('fatal', { error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  cleanup();
  app.exit(1);
});
