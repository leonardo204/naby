// electron/menu-template.ts
//
// The application menu as DATA — split out of menu.ts so it can be asserted
// against without an Electron process.
//
// `menu.ts` imports `Menu` from 'electron' at runtime, which makes it
// unloadable from a plain `tsx` spike. The template is where every decision
// actually lives (which accelerators exist, which items were deliberately
// dropped), so it moves here, behind a TYPE-ONLY electron import that is erased
// at compile. menu.ts keeps exactly one job: handing this to Electron.
//
// Two decisions are encoded here, and both are load-bearing:
//
//   1. Cmd/Ctrl+W IS NOT CLAIMED. "Close Window" keeps a menu item but carries
//      NO accelerator, so the key travels on to the page, where the tab bar
//      closes the current session tab (and, on the last tab, goes home). This is
//      the reason the app builds its own menu at all — Electron's default File
//      menu binds Cmd+W to closing the window, which in a single-window app is
//      indistinguishable from quitting.
//
//   2. RELOAD IS DROPPED FROM A PACKAGED BUILD. `role: 'viewMenu'` would bring
//      Reload (Cmd/Ctrl+R) and Force Reload (Cmd/Ctrl+Shift+R) with it, so the
//      View menu is spelled out instead: everything the role gives, minus those
//      two, plus the separator that went with them. See reload-guard.ts for why
//      reload is a pure loss in a shipped app and why development keeps it.
//      Removing the menu items is HALF the fix — the accelerators die with them,
//      but F5 was never a menu item, so the key listener in reload-guard.ts is
//      the other half.
//
// Everything else stays on Electron's own roles: the macOS app menu (whose
// Cmd+Q is confirmed in main.ts's before-quit, not here), edit, window, and the
// devtools/zoom/fullscreen items of the View menu — devtools explicitly
// included, because "no reload" must never turn into "no console".

import type { MenuItemConstructorOptions } from 'electron';

export type MenuTemplateOptions = {
  /** `process.platform === 'darwin'`. */
  isMac: boolean;
  /**
   * Whether the View menu offers Reload / Force Reload. Callers pass
   * `!app.isPackaged`; it is a parameter rather than a read of `app` so the
   * template stays pure and both branches are testable on any platform.
   */
  allowReload: boolean;
};

export function buildAppMenuTemplate(opts: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const { isMac, allowReload } = opts;

  return [
    // macOS app menu: About / Services / Hide / Quit (Cmd+Q). The quit item
    // triggers app.quit(), which main.ts intercepts for confirmation.
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        // Deliberately accelerator-less — see decision 1 in the header.
        // `role: 'close'` would re-attach Cmd+W.
        {
          label: isMac ? 'Close Window' : 'Close',
          click: (_item, win) => win?.close(),
        },
        // Windows/Linux keep quit under File (their menu bar is hidden but the
        // items stay reachable via Alt). macOS quits from the app menu above.
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Present only in a dev build. In a packaged one these two items — and
        // with them Cmd/Ctrl+R and Cmd/Ctrl+Shift+R — do not exist.
        ...(allowReload
          ? [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { type: 'separator' as const },
            ]
          : []),
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}
