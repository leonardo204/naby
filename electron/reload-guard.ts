// electron/reload-guard.ts
//
// TAKING THE BROWSER REFRESH KEYS AWAY FROM A SHIPPED BUILD.
//
// WHY. Naby is not a web page. A reload throws away the renderer's whole live
// state — the streaming connection for the turn that is running, the composer
// draft, the scroll position, the tab set — and hands back a cold boot of the
// same UI. There is nothing to "refresh": the page is served by an embedded
// server in this very process and cannot be stale. So every press of Cmd+R is a
// pure loss, and it is a press people make by reflex, not by intent, because the
// window looks like a browser.
//
// WHAT IS BLOCKED: Cmd+R, Cmd+Shift+R, Ctrl+R, Ctrl+Shift+R, F5, Ctrl+F5.
//
// WHAT IS EMPHATICALLY NOT BLOCKED: the developer tools. Cmd+Alt+I, Ctrl+Shift+I
// and F12 carry no 'r' and are not F5, so they never reach the block. That is
// asserted in the spike rather than left to be read off this comment — the day
// somebody widens the predicate to "any key with a modifier", devtools would go
// with it and the only warning would be a bug report from a user we asked to
// open the console.
//
// PACKAGED ONLY, and that is a decision rather than an oversight — see
// `ReloadGuardOptions.packaged`.
//
// TWO HALVES, BOTH REQUIRED. The accelerator lives on the application menu's
// View role (menu-template.ts drops Reload/Force Reload from a packaged build),
// and this listener catches the keystroke itself — including F5, which no menu
// item binds, and including anything Chromium might route without asking the
// menu. Blocking one and not the other leaves a working way in.
//
// NO `electron` IMPORT AT RUNTIME. The types below are type-only (erased at
// compile), so the decision function can be exercised by a plain `tsx` spike
// with no Electron process at all — which is why the predicate is a pure
// function taking a plain object rather than a closure over `app`.

/**
 * The part of Electron's `Input` this decision needs.
 *
 * Declared structurally instead of importing `Electron.Input` so a test can
 * build one with an object literal. The real `Input` has all of these (plus
 * `code`, `isAutoRepeat`, `location`, `modifiers`) so it satisfies this type.
 */
export type ReloadKeyInput = {
  /** 'keyDown' | 'keyUp' | 'char' — Chromium also emits 'rawKeyDown'. */
  type: string;
  /** The `KeyboardEvent.key` value, e.g. 'r', 'R', 'F5'. */
  key: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ReloadGuardOptions = {
  /**
   * `app.isPackaged`. THE BLOCK IS PACKAGED-ONLY.
   *
   * A shipped app has no honest use for reload: the UI it would re-fetch is
   * served by this same process and is byte-identical, so the only outcome is
   * the loss described in the header.
   *
   * Development is a different job with a different failure mode. `npm run
   * electron:dev` is the loop where the renderer DOES go stale relative to a
   * rebuilt `shell/`, and where a UI wedged by half-finished code is a normal
   * hourly event; reload is how you get back without paying a full Electron
   * relaunch (which re-runs boot, rebinds the server, and reopens the store).
   * Taking that away would buy nothing — the state a developer loses is state
   * they were about to throw out anyway — and cost a slower loop.
   *
   * It also keeps the two entries that share `createMainWindow` (SPIKE-04 and
   * the F1-10 UI spike) on the unguarded path, so nothing about the block can
   * make a keystroke assertion in those spikes depend on which branch it took.
   */
  packaged: boolean;
};

/**
 * Is this keystroke one of the browser reload bindings, in a build where reload
 * should not exist?
 *
 * Pure, and the whole decision — `installReloadGuard` adds only the plumbing.
 * That split is the point: everything worth getting wrong here (which
 * modifiers, which keys, devtools staying reachable, dev builds staying
 * reloadable) is decidable from a plain object, so it is verifiable without
 * spawning Electron and without a probe binary.
 */
export function shouldBlockReloadInput(input: ReloadKeyInput, opts: ReloadGuardOptions): boolean {
  if (!opts.packaged) return false;

  // 'keyUp' is not what triggers a reload, and swallowing it would only hide
  // the key from the page after the fact. 'char' is included because a
  // modifier+letter combination can arrive as one on some layouts, and letting
  // it through would leave the page a way to observe a key we claim to have
  // eaten.
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown' && input.type !== 'char') return false;

  const key = (input.key ?? '').toLowerCase();

  // F5 / Ctrl+F5 / Shift+F5 — the Windows-Linux refresh keys. F5 binds to
  // nothing else in this app, so the modifier state is irrelevant except for
  // Alt: Alt+F5 is a window-manager binding on some Linux desktops and is not
  // ours to swallow.
  if (key === 'f5') return input.alt !== true;

  if (key !== 'r') return false;

  // Alt+Cmd+R / Ctrl+Alt+R are not reload on any platform, and Alt is a common
  // ingredient in user-defined and system shortcuts. Only the exact reload
  // shapes are taken.
  if (input.alt === true) return false;

  // Cmd on macOS, Ctrl elsewhere. Both are checked on both platforms rather
  // than branching on `process.platform`: a keystroke this app has no meaning
  // for is not worth a platform branch, and the branch would be a second place
  // to keep in sync with the menu.
  return input.control === true || input.meta === true;
}

/** The minimum of `WebContents` this installer touches. */
type InputEventTarget = {
  on(
    event: 'before-input-event',
    listener: (event: { preventDefault(): void }, input: ReloadKeyInput) => void,
  ): unknown;
};

/**
 * Attach the guard to a window's `webContents`.
 *
 * `before-input-event` fires BEFORE both the page and the application menu see
 * the key, and `preventDefault()` there stops both — which is what makes this
 * cover the menu accelerator as well as anything the renderer might have bound.
 * The listener is registered on the webContents, so the same-origin /project
 * iframe (which shares it) is covered without a second registration.
 */
export function installReloadGuard(contents: InputEventTarget, opts: ReloadGuardOptions): void {
  // Nothing to attach in a dev build: no listener at all is cheaper and more
  // honest than one that answers false on every keystroke.
  if (!opts.packaged) return;
  contents.on('before-input-event', (event, input) => {
    if (shouldBlockReloadInput(input, opts)) event.preventDefault();
  });
}
