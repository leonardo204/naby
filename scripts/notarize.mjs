// scripts/notarize.mjs
//
// F1-10 — the `afterSign` hook. Notarises the signed `.app` with Apple, then
// STAPLES the ticket to it.
//
// WHY THIS RUNS AT `afterSign` AND NOWHERE ELSE — this is the load-bearing bit
// of the whole macOS pipeline:
//
//   A ZIP CANNOT BE STAPLED. The staple command writes the ticket INTO the
//   bundle (Contents/CodeResources' sibling), and a zip is not a bundle. The
//   only correct order is: sign the .app → notarise it → staple the .app → and
//   only THEN let electron-builder produce the .dmg and the .zip from that
//   already-stapled bundle.
//
//   `afterSign` is exactly that seam. electron-builder invokes it after the app
//   bundle is signed and BEFORE any target artifact is built, so both the .dmg
//   and the .zip end up containing a stapled app. Doing this in `afterAllArtifactBuild`
//   instead would staple nothing useful: the artifacts are already sealed.
//
// WHY THE .ZIP MATTERS EVEN THOUGH WE SHIP A .DMG: Squirrel.Mac updates via zip
// (design §6.2). The zip is the auto-update channel, so an unstapled zip means
// every updating user does an online Gatekeeper check that fails without network
// or under load. Stapling first makes the check offline and deterministic.
//
// `notarytool` ONLY. `altool` is retired and its endpoints are gone; there is no
// fallback path to write here. @electron/notarize's `tool: 'notarytool'` is the
// supported spelling, and it shells out to the same `xcrun notarytool` that is
// verified present on this machine.
//
// NO VALUE FROM THE ENVIRONMENT IS EVER PRINTED by this file. It reports which
// variables are PRESENT, never what they contain, and the Apple ID itself is not
// echoed either — it is an account identifier and belongs in nobody's build log.

import { notarize } from '@electron/notarize';
import { loadEnv } from './load-env.mjs';

/** @param {{ appOutDir: string, electronPlatformName: string, packager: any }} context */
export default async function afterSign(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  // Windows and Linux reach this hook too. Not an error — just nothing to do.
  if (electronPlatformName !== 'darwin') return;

  // Local builds get credentials from `.env`; CI has them in the ambient
  // environment already and loadEnv is a silent no-op there (no file).
  loadEnv();

  // The deliberate escape hatch. `npm run pack` and any unsigned smoke build set
  // this, because notarisation takes minutes and requires network — it must not
  // be on the inner loop.
  if (process.env.SKIP_NOTARIZE === '1' || process.env.SKIP_NOTARIZE === 'true') {
    console.log('[notarize] SKIP_NOTARIZE set — skipping (this build is NOT distributable)');
    return;
  }

  const appleId = process.env.APPLE_ID;
  // electron-builder's own documented variable is APPLE_APP_SPECIFIC_PASSWORD;
  // APPLE_ID_PASSWORD is the older spelling and is accepted as a fallback so a
  // machine configured either way works.
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD ?? process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID ?? process.env.TEAM_ID;

  const missing = [
    ['APPLE_ID', appleId],
    ['APPLE_APP_SPECIFIC_PASSWORD (or APPLE_ID_PASSWORD)', appleIdPassword],
    ['APPLE_TEAM_ID (or TEAM_ID)', teamId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    // FAIL LOUDLY RATHER THAN SHIP AN UNNOTARISED APP. A silent skip here is the
    // single most expensive failure available in this pipeline: the build
    // succeeds, the artifact uploads, and the first user sees "Naby is damaged
    // and can't be opened" — Gatekeeper's message for an unnotarised app, which
    // reads like corruption and generates support load out of proportion to the
    // cause. If the intent really is an unnotarised build, SKIP_NOTARIZE says so
    // explicitly.
    throw new Error(
      `[notarize] refusing to produce an unnotarised macOS build. Missing: ${missing.join(', ')}. ` +
        'Set them in .env (local) or repo secrets (CI), or set SKIP_NOTARIZE=1 for a deliberately ' +
        'non-distributable build.',
    );
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appName}.app to Apple (notarytool). This takes a few minutes.`);
  const startedAt = Date.now();

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  // @electron/notarize staples on success, so by the time this line runs the
  // ticket is already in the bundle and the dmg/zip built next inherit it.
  const secs = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[notarize] accepted and stapled in ${secs}s — ${appName}.app`);
}
