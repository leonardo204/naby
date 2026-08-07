// electron/menu.ts
//
// The application menu, built by hand for ONE reason: to take Cmd/Ctrl+W away
// from "close the window".
//
// With no menu of our own, Electron installs its default menu, and the default
// File menu binds Cmd+W to closing the WINDOW — which in a single-window app
// is indistinguishable from quitting. The product wants Cmd+W to mean "close
// the current session tab" (and, on the last tab, "back to the home screen"),
// which is renderer behaviour: the tab bar lives in the /project iframe and
// already knows how to do both (TabManager's keydown handler + closeTab's
// last-tab GoHome). All the main process has to do is NOT claim the key.
//
// So this menu is the default menu minus exactly one binding:
//   * "Close Window" keeps its menu item — the traffic light's keyboard-less
//     sibling — but carries NO accelerator, so the key event travels on to the
//     page, where the tab shortcut listens.
//   * Everything else is Electron's own roles (appMenu / edit / view / window),
//     which is what keeps the accelerators boot.ts relies on alive: Cmd/Ctrl+R
//     reload, Cmd/Ctrl+Shift+I devtools, zoom, fullscreen — and on macOS the
//     app menu's Cmd+Q, whose confirmation lives in main.ts (before-quit), not
//     here: the menu fires plain app.quit(), and EVERY quit path funnels
//     through that one gate.

import { Menu, type MenuItemConstructorOptions } from 'electron';

export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu: About / Services / Hide / Quit (Cmd+Q). The quit item
    // triggers app.quit(), which main.ts intercepts for confirmation.
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        // Deliberately accelerator-less — see the header comment. `role: 'close'`
        // would re-attach Cmd+W, which is the one thing this file exists to avoid.
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
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
