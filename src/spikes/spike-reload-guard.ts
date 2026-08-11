// src/spikes/spike-reload-guard.ts
//
// RELOAD BLOCKING verification — electron/reload-guard.ts + electron/menu-template.ts.
//
// WHAT IS UNDER TEST. A packaged Naby must not reload. Cmd+R / Ctrl+R / F5 tear
// down the renderer — the running turn's stream, the composer draft, the tab set
// — to re-fetch a page this same process serves and that therefore cannot be
// stale. It is a keystroke people make out of browser habit, so it has to be
// taken away rather than documented.
//
// WHY THIS IS A SPIKE AND NOT A PROBE. The repo's precedent for main-process
// verification is `electron/updater-probe.ts` + `npm run verify:updater`, which
// spawns real Electron. That shape exists because updater.ts CANNOT be tested
// otherwise: `app.isPackaged`, `app.getVersion()` and electron-updater's own
// initialisation only exist inside Electron, so a Node test would be testing
// mocks. None of that applies here. Every decision worth getting wrong — which
// modifier combinations count as reload, that devtools keys are NOT among them,
// that a dev build keeps reload, that the View menu loses the two items in a
// packaged build — is a pure function of a plain object, once the predicate is
// factored out of the listener (which is exactly why it was). So the decision is
// exercised directly, in-process, in milliseconds, on any platform, and what a
// probe would add is an Electron launch that proves nothing extra.
//
// WHAT IS LEFT UNPROVEN BY CONSTRUCTION, stated rather than hidden: that
// Electron's `before-input-event` + `preventDefault()` really does suppress a
// menu accelerator. That is Electron's documented contract, not our logic, and
// no test we can write short of driving a real keystroke into a real packaged
// window would confirm it. What IS proven here is that our listener calls
// `preventDefault` on exactly the right keys — plus, via a source assertion,
// that the guard is actually installed on the main window, which is the wiring
// mistake that would otherwise leave all of the above true and useless.
//
// It proves:
//
//   (a) PACKAGED: Cmd+R, Cmd+Shift+R, Ctrl+R, Ctrl+Shift+R, F5 and Ctrl+F5 are
//       all blocked.
//   (b) DEVTOOLS SURVIVE. Cmd+Alt+I, Ctrl+Shift+I and F12 are untouched — the
//       one thing a "block the modifier keys" over-correction would break.
//   (c) ORDINARY KEYS SURVIVE. Plain 'r', Shift+R, Cmd+C/S/W, Cmd+Alt+R and
//       Alt+F5 all pass through.
//   (d) DEV BUILDS STILL RELOAD. With `packaged: false` nothing is blocked and
//       no listener is even attached.
//   (e) EVENT TYPES. keyDown/rawKeyDown/char are considered; keyUp is not.
//   (f) THE MENU LOSES RELOAD when packaged — no `reload` or `forceReload` role
//       anywhere in the template — and KEEPS it in a dev build. Blocking the key
//       while leaving the menu item is a half fix.
//   (g) THE MENU KEEPS EVERYTHING ELSE: devtools, zoom, fullscreen, and the
//       accelerator-less "Close Window" item that is the whole reason this app
//       builds its own menu (Cmd+W must reach the renderer's tab bar).
//   (h) THE LISTENER CALLS preventDefault — the predicate wired up for real,
//       against a fake webContents.
//   (i) IT IS ACTUALLY INSTALLED: createMainWindow attaches the guard, and
//       main.ts hands the menu its packaged flag.
//
// NO ELECTRON, NO NETWORK, NO KEYS, NO DB. Prints PASS/FAIL per assertion; exits
// non-zero on any FAIL.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installReloadGuard,
  shouldBlockReloadInput,
  type ReloadKeyInput,
} from '../../electron/reload-guard.js';
import { buildAppMenuTemplate } from '../../electron/menu-template.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];

function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** A keystroke, written the way Electron delivers one. */
function press(key: string, mods: Partial<ReloadKeyInput> = {}): ReloadKeyInput {
  return { type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...mods };
}

const packaged = { packaged: true } as const;
const dev = { packaged: false } as const;

/** Every item in a template, flattened one submenu deep, as role strings. */
function rolesIn(template: ReturnType<typeof buildAppMenuTemplate>): string[] {
  const roles: string[] = [];
  for (const item of template) {
    if (item.role) roles.push(String(item.role));
    const submenu = item.submenu;
    if (Array.isArray(submenu)) {
      for (const sub of submenu) if (sub.role) roles.push(String(sub.role));
    }
  }
  return roles;
}

function main(): void {
  // -- (a) the six reload bindings, in a packaged build --------------------
  const blocked: Array<[string, ReloadKeyInput]> = [
    ['Cmd+R', press('r', { meta: true })],
    ['Cmd+Shift+R', press('r', { meta: true, shift: true })],
    ['Ctrl+R', press('r', { control: true })],
    ['Ctrl+Shift+R', press('r', { control: true, shift: true })],
    ['F5', press('F5')],
    ['Ctrl+F5', press('F5', { control: true })],
    // Uppercase arrives when Shift is held on some layouts; the predicate must
    // not be case-sensitive.
    ['Cmd+Shift+R (key="R")', press('R', { meta: true, shift: true })],
  ];
  for (const [name, input] of blocked) {
    record(`(a) ${name} is blocked in a packaged build`, shouldBlockReloadInput(input, packaged), `blocked=${shouldBlockReloadInput(input, packaged)}`);
  }

  // -- (b) devtools must stay reachable ------------------------------------
  const devtools: Array<[string, ReloadKeyInput]> = [
    ['Cmd+Alt+I', press('i', { meta: true, alt: true })],
    ['Ctrl+Shift+I', press('i', { control: true, shift: true })],
    ['F12', press('F12')],
  ];
  for (const [name, input] of devtools) {
    record(
      `(b) ${name} still opens the developer tools`,
      shouldBlockReloadInput(input, packaged) === false,
      `blocked=${shouldBlockReloadInput(input, packaged)}`,
    );
  }

  // -- (c) everything else passes through ----------------------------------
  const allowed: Array<[string, ReloadKeyInput]> = [
    ['a bare "r"', press('r')],
    ['Shift+R (typing a capital)', press('R', { shift: true })],
    ['Cmd+C', press('c', { meta: true })],
    ['Cmd+S', press('s', { meta: true })],
    // The tab-close shortcut the whole custom menu exists to protect.
    ['Cmd+W', press('w', { meta: true })],
    ['Cmd+Alt+R (not a reload binding)', press('r', { meta: true, alt: true })],
    ['Ctrl+Alt+R (not a reload binding)', press('r', { control: true, alt: true })],
    ['Alt+F5 (a window-manager binding)', press('F5', { alt: true })],
  ];
  for (const [name, input] of allowed) {
    record(
      `(c) ${name} is not blocked`,
      shouldBlockReloadInput(input, packaged) === false,
      `blocked=${shouldBlockReloadInput(input, packaged)}`,
    );
  }

  // -- (d) a dev build reloads as before -----------------------------------
  const devUnblocked = blocked.every(([, input]) => shouldBlockReloadInput(input, dev) === false);
  record(
    '(d) NOTHING is blocked when the build is not packaged',
    devUnblocked,
    `${blocked.length} reload bindings, all allowed in dev`,
  );

  {
    let listeners = 0;
    installReloadGuard({ on: () => (listeners += 1) }, dev);
    record(
      '(d) a dev build does not even attach a listener',
      listeners === 0,
      `listeners=${listeners}`,
    );
  }

  // -- (e) event types ------------------------------------------------------
  record(
    '(e) keyDown, rawKeyDown and char are all considered',
    ['keyDown', 'rawKeyDown', 'char'].every((type) =>
      shouldBlockReloadInput({ ...press('r', { meta: true }), type }, packaged),
    ),
    'keyDown/rawKeyDown/char → blocked',
  );
  record(
    '(e) keyUp is left alone (blocking it would suppress nothing)',
    shouldBlockReloadInput({ ...press('r', { meta: true }), type: 'keyUp' }, packaged) === false,
    'keyUp → not blocked',
  );

  // -- (f) the menu loses Reload / Force Reload in a packaged build --------
  const macPackaged = rolesIn(buildAppMenuTemplate({ isMac: true, allowReload: false }));
  const winPackaged = rolesIn(buildAppMenuTemplate({ isMac: false, allowReload: false }));
  const macDev = rolesIn(buildAppMenuTemplate({ isMac: true, allowReload: true }));

  const noReload = (roles: string[]): boolean =>
    !roles.includes('reload') && !roles.includes('forceReload');
  record(
    '(f) a packaged build has NO Reload / Force Reload menu item (macOS)',
    noReload(macPackaged),
    `roles=[${macPackaged.join(', ')}]`,
  );
  record(
    '(f) …nor on Windows/Linux',
    noReload(winPackaged),
    `roles=[${winPackaged.join(', ')}]`,
  );
  record(
    '(f) a dev build keeps both',
    macDev.includes('reload') && macDev.includes('forceReload'),
    `reload=${macDev.includes('reload')} forceReload=${macDev.includes('forceReload')}`,
  );
  // The default `viewMenu` role would smuggle Reload back in wholesale — the
  // exact regression this file guards against.
  record(
    "(f) the View menu is spelled out, never `role: 'viewMenu'`",
    !macPackaged.includes('viewMenu') && !winPackaged.includes('viewMenu'),
    `viewMenu present = ${macPackaged.includes('viewMenu')}`,
  );

  // -- (g) and keeps everything a menu is otherwise for ---------------------
  for (const role of ['toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']) {
    record(
      `(g) a packaged build keeps ${role}`,
      macPackaged.includes(role),
      `present=${macPackaged.includes(role)}`,
    );
  }
  {
    // Cmd/Ctrl+W must stay UNCLAIMED so the renderer's tab bar gets it: the
    // Close item exists but carries no accelerator and is not `role: 'close'`.
    const file = buildAppMenuTemplate({ isMac: true, allowReload: false }).find(
      (i) => i.label === 'File',
    );
    const submenu = Array.isArray(file?.submenu) ? file.submenu : [];
    const close = submenu[0];
    record(
      '(g) "Close Window" still has no accelerator and no close role (Cmd+W reaches the tab bar)',
      close?.label === 'Close Window' && close?.accelerator === undefined && close?.role === undefined,
      `label=${String(close?.label)} accelerator=${String(close?.accelerator)} role=${String(close?.role)}`,
    );
  }

  // -- (h) the listener actually prevents the default ----------------------
  {
    type Listener = (event: { preventDefault(): void }, input: ReloadKeyInput) => void;
    let listener: Listener | undefined;
    installReloadGuard(
      {
        on: (_event, fn) => {
          listener = fn as Listener;
        },
      },
      packaged,
    );

    const fire = (input: ReloadKeyInput): boolean => {
      let prevented = false;
      listener?.(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        input,
      );
      return prevented;
    };

    record(
      '(h) the installed listener calls preventDefault on Cmd+R and F5',
      listener !== undefined && fire(press('r', { meta: true })) && fire(press('F5')),
      `listenerAttached=${listener !== undefined}`,
    );
    record(
      '(h) …and leaves Cmd+Alt+I and a bare "r" alone',
      fire(press('i', { meta: true, alt: true })) === false && fire(press('r')) === false,
      'devtools + typing pass through the real listener',
    );
  }

  // -- (i) it is wired into the window and the menu -------------------------
  //
  // A perfect predicate that nothing calls is the failure mode a pure-function
  // test cannot see. These read the production sources, in the same spirit as
  // spike-devmode's (i).
  {
    const bootSrc = readFileSync(join(REPO, 'electron', 'boot.ts'), 'utf8');
    record(
      '(i) createMainWindow installs the guard on the window webContents',
      /installReloadGuard\(\s*win\.webContents\s*,/.test(bootSrc) &&
        /packaged:\s*opts\.packaged\s*\?\?\s*app\.isPackaged/.test(bootSrc),
      'boot.ts calls installReloadGuard(win.webContents, { packaged: … app.isPackaged })',
    );

    const mainSrc = readFileSync(join(REPO, 'electron', 'main.ts'), 'utf8');
    record(
      '(i) main.ts hands the menu the packaged flag',
      /installApplicationMenu\(\{\s*packaged:\s*app\.isPackaged\s*\}\)/.test(mainSrc),
      'main.ts calls installApplicationMenu({ packaged: app.isPackaged })',
    );
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.evidence}]`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
