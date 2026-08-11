// electron/menu.ts
//
// Installs the application menu. The TEMPLATE — and every decision in it — lives
// in menu-template.ts, which has no runtime `electron` import and can therefore
// be asserted against from a spike. This file is the one line that needs
// Electron.
//
// The menu exists for two reasons, both documented at length in menu-template.ts:
// it does NOT claim Cmd/Ctrl+W (so the key reaches the renderer's tab bar), and
// in a PACKAGED build it does not offer Reload / Force Reload (so Cmd/Ctrl+R has
// nothing to fire). Everything else is Electron's own roles, which is what keeps
// devtools, zoom and fullscreen alive — dropping the application menu entirely
// would take those with it.

import { app, Menu } from 'electron';
import { buildAppMenuTemplate } from './menu-template.js';

export type InstallMenuOptions = {
  /**
   * `app.isPackaged` by default. A packaged build loses Reload / Force Reload;
   * a dev run keeps them (reload-guard.ts explains why the two differ). Passed
   * explicitly by main.ts so the decision is visible at the call site.
   */
  packaged?: boolean;
};

export function installApplicationMenu(opts: InstallMenuOptions = {}): void {
  const packaged = opts.packaged ?? app.isPackaged;
  const template = buildAppMenuTemplate({
    isMac: process.platform === 'darwin',
    allowReload: !packaged,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
