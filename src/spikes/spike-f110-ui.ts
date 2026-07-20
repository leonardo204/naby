// src/spikes/spike-f110-ui.ts
//
// SPIKE-F110 — the three UI claims of the tab-close / login-status / branding
// change set, asserted against the REAL DOM of a REAL Electron boot.
//
// WHY A SPIKE AND NOT A CODE REVIEW. Every claim here is a claim about what a
// person sees, and each one has a failure mode that a diff cannot show:
//
//   * "the × is on every tab" — removing the `tabs.length > 1` gate is visible
//     in a diff, but "and closing the last one does not leave a broken shell"
//     is not.
//   * "hover reveals it" — the reveal is a CSS `:hover` rule. It is not
//     observable from JavaScript unless a REAL cursor moves, which is why the
//     entry dispatches a real input event instead of a synthetic MouseEvent.
//   * "the title is Naby" — three independent mechanisms set it (SSR metadata,
//     a client effect, the OS window). A diff that fixes two of three looks
//     complete.
//   * "the login dot reflects the real state" — a green dot is easy; a green
//     dot that is CORRECT requires comparing the UI against an independent
//     answer, which is what assertion (f) does.
//
// SHAPE, as SPIKE-04 / SPIKE-F104: the driver spawns Electron on
// `dist/electron/spike-f110-entry.mjs`, which emits NDJSON. PASS/FAIL is decided
// HERE, so a probe that never ran is a missing observation — a FAIL — rather
// than an assertion that silently never executed.
//
// Assertions:
//   (a) the close × is present on EVERY tab, including the last remaining one
//   (b) it is hidden until the tab is hovered, and a real hover reveals it
//   (c) closing the last tab lands on the home screen, keeps the project
//       iframes mounted, and leaves the iframe with a fresh tab (not an empty
//       shell)
//   (d) the window title is exactly `Naby (Alpha version)` — no directory suffix
//   (e) no `Cockpit` / `OpenCockpit` text remains in the rendered UI
//   (f) the Claude login indicator renders beside the engine toggle and its
//       status matches the runtime's independent answer
//   (i) the chat stream's WebSocket channel is dispatched: a same-origin
//       handshake from the page OPENS and is answered with a snapshot
//   (j) a fresh profile's home screen lists NOTHING — not the machine-wide
//       scan of ~/.claude/projects — and offers Open and Create
//   (k) opening a project adds EXACTLY ONE entry, at the top, and it survives
//       a real reload
//   (l) the × removes that entry, the removal survives a reload, and
//  (l2) the project's directory and past sessions are untouched — reopening it
//       brings the same sessions back

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(ROOT, 'dist/electron/spike-f110-entry.mjs');
const MARK = '##SPIKEF110##';

// Raised from 240s for the recents assertions (j/k/l), which add three real
// page loads — persistence has to be proven across a navigation, not across a
// re-render, so the reloads are the assertion and cannot be traded away.
const RUN_TIMEOUT_MS = 420_000;

/** The product name, duplicated from the shell's branding module on purpose.
 *  Importing it would make this assertion tautological — it would prove the two
 *  files agree, not that the title says what the requirement says. */
const EXPECTED_TITLE = 'Naby (Alpha version)';

type Check = { name: string; pass: boolean; evidence: string };
type Obs = { event: string; [k: string]: unknown };

type ChildOutcome = {
  observations: Obs[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

async function runElectron(): Promise<ChildOutcome> {
  const electronBinary = require('electron') as string;

  const child = spawn(electronBinary, [ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // The dev engine, forced. This is the configuration the login indicator
      // exists to serve, and forcing it means the assertion does not depend on
      // whether the developer running the spike happens to have a provider key.
      NABY_ENGINE: 'dev-claude',
    },
  });

  const observations: Obs[] = [];
  let stdoutBuf = '';
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf(MARK);
      if (at === -1) continue;
      try {
        observations.push(JSON.parse(line.slice(at + MARK.length)) as Obs);
      } catch {
        /* a partial or malformed line is simply not an observation */
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);
    // 'close', not 'exit' — 'exit' can fire while the stdio pipes still hold
    // the final observation, and that race is load-dependent, i.e. it shows up
    // only inside `spike:nokeys`. Three of those have already been fixed here.
    child.on('close', (c) => {
      clearTimeout(timer);
      resolvePromise(c);
    });
  });

  return { observations, exitCode: code, timedOut, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function findOne(obs: Obs[], event: string): Obs | undefined {
  return obs.find((o) => o.event === event);
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function evaluate(outcome: ChildOutcome): Check[] {
  const obs = outcome.observations;
  const checks: Check[] = [];

  const fatal = findOne(obs, 'fatal');
  const ready = findOne(obs, 'ready');
  const title = findOne(obs, 'title');
  const branding = findOne(obs, 'branding');
  const reduced = findOne(obs, 'reduced');
  const hover = findOne(obs, 'hover');
  const home = findOne(obs, 'home');
  const login = findOne(obs, 'login');
  const wsStream = findOne(obs, 'wsStream');
  const done = findOne(obs, 'done');

  // -- (i) the chat stream's WebSocket channel is dispatched ----------------
  //
  // REGRESSION GUARD. `next-server.ts` used to pass every upgrade straight to
  // Next, which does not know the shell's `/ws/*` routes and does not refuse an
  // unknown one — it leaves the socket open and unanswered. Chat therefore died
  // silently: no server log, no client error, just useChatStream's 15s watchdog
  // writing "An error occurred, please retry" while every other surface of the
  // app kept working.
  //
  // THE OUTCOME MUST BE `message`, NOT MERELY "NOT HUNG". The handler sends a
  // snapshot immediately on connect, and that snapshot is the thing the chat
  // client waits for; a socket that opened and then sat silent would reproduce
  // the original bug exactly. `hung` is reported as its own outcome so the
  // failure reads as the real one rather than as a timeout somewhere.
  //
  // This is also the POSITIVE half of the hardening story — a page-created
  // WebSocket carries no custom header, so accepting it proves the HttpOnly
  // token cookie authenticates a same-origin upgrade. SPIKE-04 still owns the
  // four refusals (foreign Host, foreign Origin, no token, wrong token).
  checks.push({
    name: '(i) /ws/session-stream accepts a same-origin handshake from the page and answers with a snapshot',
    pass:
      wsStream?.outcome === 'message' &&
      wsStream.opened === true &&
      typeof wsStream.messageType === 'string' &&
      (wsStream.messageType as string).length > 0,
    evidence: wsStream
      ? `url=${String(wsStream.url)} outcome=${String(wsStream.outcome)} opened=${String(wsStream.opened)} ` +
        `firstMessageType=${JSON.stringify(wsStream.messageType ?? null)} bytes=${String(wsStream.bytes ?? 0)}` +
        (wsStream.outcome === 'hung'
          ? ' — the upgrade was never answered: the shell WS dispatcher is not wired into next-server.ts'
          : '') +
        (wsStream.outcome === 'closed'
          ? ` closeCode=${String(wsStream.code)} reason=${JSON.stringify(wsStream.reason ?? '')}`
          : '')
      : 'no `wsStream` observation',
  });

  // -- (a) a close button on every tab, including the last -----------------
  //
  // `reduced.tabCount === 1` is the load-bearing half: the entry closed tabs
  // until one remained, and that one STILL exposes a close button. Under the
  // old `tabs.length > 1` gate the last button would have disappeared and this
  // would read 0.
  checks.push({
    name: '(a) the close × is rendered on every tab, including the last remaining one',
    pass:
      ready?.iframePresent === true &&
      typeof ready.tabCloseButtons === 'number' &&
      (ready.tabCloseButtons as number) >= 1 &&
      reduced?.tabCount === 1 &&
      rec(hover?.pre).found === true,
    evidence:
      ready && reduced
        ? `iframe=${String(ready.iframePresent)} closeButtonsAtStart=${String(ready.tabCloseButtons)} ` +
          `afterReducingToOne=${String(reduced.tabCount)} lastTabHasCloseButton=${String(rec(hover?.pre).found)}`
        : 'missing `ready` or `reduced` observation',
  });

  // -- (b) hidden until hovered, revealed by a REAL hover -------------------
  const pre = rec(hover?.pre);
  const post = rec(hover?.post);
  const preOpacity = parseFloat(String(pre.opacity ?? 'NaN'));
  const postOpacity = parseFloat(String(post.opacity ?? 'NaN'));
  checks.push({
    name: '(b) the × is hidden at rest and a real mouse hover over the tab reveals it',
    pass:
      pre.found === true &&
      post.found === true &&
      preOpacity === 0 &&
      postOpacity === 1 &&
      // Independent proof the cursor actually landed on the tab, so an opacity
      // of 1 cannot be explained by "the button was simply always visible".
      post.tabHovered === true &&
      String(pre.className ?? '').includes('group-hover:opacity-100'),
    evidence: hover
      ? `opacityAtRest=${String(pre.opacity)} opacityWhileHovered=${String(post.opacity)} ` +
        `tabMatchesHover=${String(post.tabHovered)} hasHoverClass=${String(String(pre.className ?? '').includes('group-hover:opacity-100'))} ` +
        `dispatch=${String(hover.dispatch)} aimedAt=(${String(pre.tabX)},${String(pre.tabY)}) ` +
        `hoverChain=${JSON.stringify(post.hoveredTail ?? '')} ` +
        `parentHover=${String(post.parentHoverCount)}/${String(post.parentHoverTail)} ` +
        `elementAtPoint=${String(post.elementAtPoint)} viewport=${String(post.viewport)} ` +
        `iframeRect=${String(pre.iframeRect)} tabRect=${String(pre.tabRect)}`
      : 'no `hover` observation',
  });

  // -- (c) closing the last tab lands on the home screen --------------------
  checks.push({
    name: '(c) closing the LAST tab shows the home screen, keeps project iframes mounted, and re-seeds a tab (no empty shell)',
    pass:
      home?.clicked === true &&
      home.homeVisible === true &&
      home.homeHasSize === true &&
      home.iframeStillMounted === true &&
      home.iframeContainerHidden === true &&
      home.iframeTabsAfter === 1 &&
      // The title must stop naming the project the user just left.
      home.titleAfter === EXPECTED_TITLE,
    evidence: home
      ? `homeVisible=${String(home.homeVisible)} homeHasHeight=${String(home.homeHasSize)} ` +
        `iframeMounted=${String(home.iframeStillMounted)} iframeContainerHidden=${String(home.iframeContainerHidden)} ` +
        `tabsInIframeAfterClose=${String(home.iframeTabsAfter)} ` +
        `title: ${JSON.stringify(home.titleBefore)} → ${JSON.stringify(home.titleAfter)}`
      : 'no `home` observation',
  });

  // -- (c2) the home screen scrolls ----------------------------------------
  //
  // Separate from (c) on purpose: (c) proves the home screen APPEARS, and it
  // passed throughout the bug where the screen appeared but the project list
  // ran off the bottom of the window with nothing scrollable.
  checks.push({
    name: '(c2) the home screen is clipped to the viewport and its project list actually scrolls',
    pass:
      home?.homeScrollProbe === 'ok' &&
      home.homeFitsViewport === true &&
      home.scrollerOverflows === true &&
      home.scrollerMoved === true,
    evidence: home
      ? `probe=${String(home.homeScrollProbe)} fitsViewport=${String(home.homeFitsViewport)} ` +
        `overflows=${String(home.scrollerOverflows)} scrolled=${String(home.scrollerMoved)}`
      : 'no `home` observation',
  });

  // -- (d) the window title -------------------------------------------------
  //
  // The title is the product name and NOTHING else. It used to append the
  // working directory, which read as if the app were named after whichever
  // project happened to be open. Asserting the project name is ABSENT is the
  // point: a title that grows a suffix again fails here.
  const documentTitle = String(title?.documentTitle ?? '');
  const windowTitle = String(title?.windowTitle ?? '');
  const projectName = String(findOne(obs, 'window')?.projectName ?? ' ');
  const startsRight = documentTitle === EXPECTED_TITLE;
  const dirAbsent = projectName.trim() !== '' && !documentTitle.includes(projectName);


  checks.push({
    name: `(d) the window title is exactly \`${EXPECTED_TITLE}\`, with no directory appended`,
    pass:
      startsRight &&
      dirAbsent &&
      windowTitle === EXPECTED_TITLE &&
      !/Cockpit/i.test(documentTitle) &&
      !/Cockpit/i.test(windowTitle),
    evidence: title
      ? `document.title=${JSON.stringify(documentTitle)} BrowserWindow.getTitle()=${JSON.stringify(windowTitle)} ` +
        `iframeTitle=${JSON.stringify(title.iframeTitle)} exactProductName=${String(startsRight)} ` +
        `projectNameAbsent=${String(dirAbsent)} project=${JSON.stringify(projectName)}`
      : 'no `title` observation',
  });

  // -- (e) no upstream branding on screen -----------------------------------
  const parentHits = Array.isArray(branding?.parentHits) ? (branding.parentHits as string[]) : ['<missing>'];
  const iframeHits = Array.isArray(branding?.iframeHits) ? (branding.iframeHits as string[]) : ['<missing>'];
  checks.push({
    name: '(e) no `Cockpit` / `OpenCockpit` text remains in the rendered UI of either document, and `Naby` identifies the app',
    pass:
      branding !== undefined &&
      parentHits.length === 0 &&
      iframeHits.length === 0 &&
      branding.nabyInTitle === true,
    evidence: branding
      ? `parentWindowHits=[${parentHits.join(',')}] iframeHits=[${iframeHits.join(',')}] ` +
        `nabyInTitle=${String(branding.nabyInTitle)} nabyInParentText=${String(branding.nabyInParentText)}`
      : 'no `branding` observation',
  });

  // -- (f) the login indicator, checked against an independent answer -------
  //
  // The UI's status must EQUAL the runtime's, and the remedy must be present
  // exactly when the runtime says there is one. A green dot on a signed-out
  // machine and an amber dot on a signed-in one fail this equally.
  const dom = rec(login?.dom);
  const truthStatus = String(login?.truthStatus ?? '');
  const remedyExpected = login?.truthHasRemedy === true;
  checks.push({
    name: '(f) the Claude login indicator renders beside the engine toggle and its status matches the runtime',
    pass:
      dom.present === true &&
      dom.besideEngineToggle === true &&
      dom.status === truthStatus &&
      // Signed out must SAY WHAT TO DO — the entire point of the feature.
      dom.remedyShown === remedyExpected &&
      (!remedyExpected || String(dom.remedyText ?? '').includes('claude login')) &&
      // The label is readable text, not an unlabelled dot.
      /Claude:/.test(String(dom.text ?? '')),
    evidence: login
      ? `uiStatus=${String(dom.status)} runtimeStatus=${truthStatus} agree=${String(dom.status === truthStatus)} ` +
        `label=${JSON.stringify(dom.text)} dotColor=${String(dom.dotColor)} ` +
        `besideEngineToggle=${String(dom.besideEngineToggle)} ` +
        `remedyShown=${String(dom.remedyShown)} (expected ${String(remedyExpected)}) ` +
        `remedy=${JSON.stringify(dom.remedyText)} claudeCliOnPath=${String(login.truthCliFound)}`
      : 'no `login` observation',
  });

  // -- (g) the signed-out branch --------------------------------------------
  //
  // The assertion that actually matters. A signed-out machine must be TOLD, in
  // the UI, with the command that fixes it — and must still be usable, because
  // this is advice, not a gate.
  const signedOut = findOne(obs, 'signedOut');
  const so = rec(signedOut?.dom);
  checks.push({
    name: '(g) with the Claude sign-in removed, the indicator flips to signed-out on its own re-check trigger and says `claude login`',
    pass:
      signedOut !== undefined &&
      // The environment change really did produce a signed-out runtime — if it
      // did not, the UI agreeing with it would prove nothing.
      signedOut.truthStatus === 'signed-out' &&
      so.status === 'signed-out' &&
      /signed out/i.test(String(so.text ?? '')) &&
      so.remedyShown === true &&
      String(so.remedyText ?? '').includes('claude login') &&
      // A user who has just run the command needs a way to say so.
      so.recheckOffered === true &&
      // Nothing is blocked: the composer stays enabled.
      so.composerDisabled === false,
    evidence: signedOut
      ? `runtimeStatus=${String(signedOut.truthStatus)} uiStatus=${String(so.status)} ` +
        `label=${JSON.stringify(so.text)} dotColor=${String(so.dotColor)} ` +
        `remedy=${JSON.stringify(so.remedyText)} recheckButton=${String(so.recheckOffered)} ` +
        `composerDisabled=${String(so.composerDisabled)} tooltip=${JSON.stringify(so.tooltip)}`
      : 'no `signedOut` observation',
  });

  // -- (j) a fresh profile shows an empty recents list, not a disk scan -----
  //
  // THE ASSERTION THIS CHANGE EXISTS FOR. The home screen used to render
  // `/api/sessions/projects`, i.e. every directory the user had ever run Claude
  // Code in — 39 of them on the machine this was written on. The spike boots
  // with a temp COCKPIT_HOME (so the app's own record of opened projects is
  // empty) but the developer's REAL home (so the scan is still full). The scan
  // must therefore return many while the screen shows none.
  //
  // `machineProjects > 0` is part of the assertion, not decoration: on a
  // machine with no Claude history at all, "the list is empty" would be true
  // for the wrong reason and would prove nothing.
  const fresh = findOne(obs, 'fresh');
  checks.push({
    name: '(j) a fresh profile lands on an empty recents list — no machine-wide project scan — and is offered Open and Create',
    pass:
      fresh?.homeVisible === true &&
      fresh.rows === 0 &&
      fresh.emptyStateShown === true &&
      // Not a blank panel: it explains itself.
      typeof fresh.emptyStateWords === 'number' &&
      (fresh.emptyStateWords as number) >= 10 &&
      fresh.openAffordances === 1 &&
      fresh.createAffordances === 1 &&
      typeof fresh.machineProjects === 'number' &&
      (fresh.machineProjects as number) > 0 &&
      fresh.machinePathsOnScreen === 0,
    evidence: fresh
      ? `rowsOnHome=${String(fresh.rows)} emptyState=${String(fresh.emptyStateShown)} ` +
        `emptyStateWords=${String(fresh.emptyStateWords)} openButtons=${String(fresh.openAffordances)} ` +
        `createButtons=${String(fresh.createAffordances)} openLabel=${JSON.stringify(fresh.openLabel)} ` +
        `projectsAScanWouldOffer=${String(fresh.machineProjects)} ofThoseRendered=${String(fresh.machinePathsOnScreen)}`
      : 'no `fresh` observation',
  });

  // -- (k) opening a project adds exactly one entry, and it persists --------
  //
  // The expected count is derived from the FIXTURE's own observation rather
  // than hard-coded, so a fixture that seeds a different number fails loudly
  // instead of quietly agreeing with a stale constant.
  const seeded = findOne(obs, 'seeded');
  const seedCount = typeof seeded?.seeded === 'number' ? (seeded.seeded as number) : -1;
  const afterOpen = findOne(obs, 'recentsAfterOpen');
  const afterReload = findOne(obs, 'recentsAfterReload');
  checks.push({
    name: '(k) opening a project adds EXACTLY ONE entry, sorted to the top, and it survives a real reload',
    pass:
      seedCount > 0 &&
      afterOpen?.rows === seedCount + 1 &&
      afterOpen.targetRows === 1 &&
      // lastOpenedAt is doing its job: the seeded entries are hours older.
      afterOpen.targetIsFirst === true &&
      // …and again after a full page load, so the list came from the persisted
      // store rather than from React state that happened to survive.
      afterReload?.reachedHome === true &&
      afterReload.rows === seedCount + 1 &&
      afterReload.targetRows === 1 &&
      afterReload.targetIsFirst === true,
    evidence:
      afterOpen && afterReload
        ? `seeded=${String(seedCount)} rowsAfterOpen=${String(afterOpen.rows)} (expected ${String(seedCount + 1)}) ` +
          `entriesForOpenedProject=${String(afterOpen.targetRows)} sortedFirst=${String(afterOpen.targetIsFirst)} ` +
          `afterReload: reachedHome=${String(afterReload.reachedHome)} rows=${String(afterReload.rows)} ` +
          `entriesForOpenedProject=${String(afterReload.targetRows)} sortedFirst=${String(afterReload.targetIsFirst)}`
        : 'missing `recentsAfterOpen` or `recentsAfterReload` observation',
  });

  // -- (l) the × removes it from the list, and that sticks ------------------
  const removed = findOne(obs, 'removed');
  const afterRemoveReload = findOne(obs, 'recentsAfterRemoveReload');
  const tooltip = String(afterOpen?.removeTooltip ?? '');
  checks.push({
    name: '(l) the × removes that entry and only that entry, the removal survives a reload, and the button says it only touches the list',
    pass:
      removed?.clicked === true &&
      removed.before === seedCount + 1 &&
      removed.after === seedCount &&
      removed.targetGone === true &&
      removed.homeStillVisible === true &&
      afterRemoveReload?.reachedHome === true &&
      afterRemoveReload.rows === seedCount &&
      afterRemoveReload.targetRows === 0 &&
      // Unmistakable in the UI, per the requirement — the tooltip on the button
      // itself, plus a standing note beside the list.
      /stay on disk/i.test(tooltip) &&
      String(afterOpen?.removalNote ?? '').length > 0,
    evidence: removed
      ? `clicked=${String(removed.clicked)} rows ${String(removed.before)} → ${String(removed.after)} ` +
        `targetGone=${String(removed.targetGone)} stayedOnHome=${String(removed.homeStillVisible)} ` +
        `afterReload: rows=${String(afterRemoveReload?.rows)} entriesForRemovedProject=${String(afterRemoveReload?.targetRows)} ` +
        `tooltip=${JSON.stringify(tooltip)} note=${JSON.stringify(afterOpen?.removalNote ?? '')}`
      : 'no `removed` observation',
  });

  // -- (l2) nothing on disk was touched ------------------------------------
  //
  // The half of "remove" that would be catastrophic to get wrong. Checked from
  // both sides: the main process stats the directory and the fixture session
  // file, and the app is asked for that path's session history — which must
  // still answer — before the project is reopened and the SAME session is read
  // back out of the DOM.
  const untouched = findOne(obs, 'untouched');
  const reopened = findOne(obs, 'reopened');
  checks.push({
    name: "(l2) removal touches no files: the directory, its contents and its past sessions survive, and reopening the project brings them back",
    pass:
      untouched?.dirExists === true &&
      typeof untouched.dirEntries === 'number' &&
      (untouched.dirEntries as number) >= 1 &&
      untouched.sessionFileExists === true &&
      typeof untouched.sessionsViaApi === 'number' &&
      (untouched.sessionsViaApi as number) >= 1 &&
      reopened?.reachedHome === true &&
      reopened.rowBack === true &&
      reopened.rows === seedCount + 1 &&
      typeof reopened.sessions === 'number' &&
      (reopened.sessions as number) >= 1 &&
      // Read from the rendered row, not from the API a second time.
      reopened.fixtureVisible === true,
    evidence:
      untouched && reopened
        ? `projectDirExists=${String(untouched.dirExists)} entriesInDir=${String(untouched.dirEntries)} ` +
          `sessionFileExists=${String(untouched.sessionFileExists)} sessionsFromApiWhileRemoved=${String(untouched.sessionsViaApi)} ` +
          `afterReopen: reachedHome=${String(reopened.reachedHome)} entryBack=${String(reopened.rowBack)} rows=${String(reopened.rows)} ` +
          `sessionsRenderedInRow=${String(reopened.sessions)} fixtureSessionTextVisible=${String(reopened.fixtureVisible)}`
        : 'missing `untouched` or `reopened` observation',
  });

  // -- housekeeping ---------------------------------------------------------
  checks.push({
    name: '(h) the run completed cleanly, with no fatal error in main',
    pass: !fatal && !outcome.timedOut && outcome.exitCode === 0 && done !== undefined,
    evidence:
      (fatal ? `FATAL in main: ${String(fatal.error)} · ` : '') +
      `exitCode=${String(outcome.exitCode)} timedOut=${String(outcome.timedOut)} ` +
      `observations=${obs.length}`,
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('SPIKE-F110 — tab close → home, window title, Claude login status (real DOM)\n');

  if (!existsSync(ENTRY)) {
    console.error(`FAIL: ${ENTRY} is missing.`);
    console.error('      Run `npm run build:app` first (npm run spike:f110 does this for you).');
    process.exit(1);
  }

  const outcome = await runElectron();
  const checks = evaluate(outcome);

  // Authoritative cleanup of the child's temp dirs, now that the process is
  // gone and nothing is writing into them. Best-effort and never a FAIL —
  // a leftover directory in /tmp is not a UI defect.
  const done = outcome.observations.find((o) => o.event === 'done');
  for (const key of ['tempUserData', 'tempCockpitHome', 'tempProject'] as const) {
    const dir = done?.[key];
    if (typeof dir === 'string' && dir.includes('naby-f110-')) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} assertions passed`);

  if (failed.length > 0) {
    const tail = outcome.stderr.trim().split('\n').slice(-40).join('\n');
    if (tail) console.error(`\n--- electron stderr (tail) ---\n${tail}`);
    process.exit(1);
  }
}

void main();
