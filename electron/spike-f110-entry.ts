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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const loaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 90_000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  // `?cwd=` is the deterministic way in: Workspace adds the project to its list
  // and mounts its iframe, which is what gives us a tab bar to assert against.
  // Seeding ~/.cockpit/state.json instead would test our seeding, not the app.
  await win.loadURL(bootResult.windowUrl(`/?cwd=${encodeURIComponent(projectDir)}`));
  const windowLoaded = await loaded;
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
       };
     })()`,
  )) as Record<string, unknown>;
  emit('home', home);

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
