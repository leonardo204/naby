// scripts/notarize-dmg.mjs
//
// F1-10 — the `afterAllArtifactBuild` hook. Notarises and staples the .dmg.
//
// WHY THIS IS A SECOND NOTARISATION AND NOT A DUPLICATE OF scripts/notarize.mjs.
// A notarisation ticket covers ONE container. `afterSign` notarises and staples
// the `.app`, which is what makes the installed application launch cleanly and
// is what Squirrel needs for updates. The `.dmg` built afterwards is a DIFFERENT
// container with its own code-signature and its own quarantine attributes, and
// it has no ticket of its own.
//
// The user-visible consequence of skipping this step is subtle and easy to miss
// in testing, because it does not fail on the machine that built it:
//
//   * The .app inside is stapled, so once copied to /Applications it launches
//     offline, forever. That part is already correct.
//   * But the DMG the user actually DOWNLOADS is quarantined, and Gatekeeper
//     assesses the DMG when they open it. With no stapled ticket, that
//     assessment requires a live round trip to Apple. Offline, behind a captive
//     portal, or during an Apple outage, opening the disk image fails — and the
//     dialog says the image is damaged, not that a network check failed.
//
// So: staple the app (afterSign, before the dmg is built — a zip cannot be
// stapled, which is why that ordering is fixed), then staple the dmg (here,
// after it exists). Two containers, two tickets, two staples.
//
// THE ZIP IS DELIBERATELY NOT PROCESSED HERE. A ZIP cannot carry a staple at
// all; it is a transport format, not a bundle. It does not need one either —
// Squirrel unpacks it and validates the .app inside, which IS stapled.

import { execFile } from 'node:child_process';
import { notarize } from '@electron/notarize';
import { loadEnv } from './load-env.mjs';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || stdout || err.message)}`));
      else resolve(String(stdout));
    });
  });
}

/** @param {{ artifactPaths: string[], platformToTargets: Map<any, any> }} context */
export default async function afterAllArtifactBuild(context) {
  const dmgs = (context.artifactPaths ?? []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];

  loadEnv();

  if (process.env.SKIP_NOTARIZE === '1' || process.env.SKIP_NOTARIZE === 'true') {
    console.log('[notarize-dmg] SKIP_NOTARIZE set — skipping (this .dmg is NOT distributable)');
    return [];
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD ?? process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID ?? process.env.TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    // Same reasoning as scripts/notarize.mjs: an unnotarised artifact that
    // builds and uploads successfully is worse than a failed build, because the
    // failure surfaces to users as "the disk image is damaged".
    throw new Error(
      '[notarize-dmg] refusing to emit an unnotarised .dmg — Apple credentials are missing. ' +
        'Set SKIP_NOTARIZE=1 for a deliberately non-distributable build.',
    );
  }

  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] submitting ${dmg} to Apple (notarytool).`);
    const startedAt = Date.now();

    await notarize({ tool: 'notarytool', appPath: dmg, appleId, appleIdPassword, teamId });

    // @electron/notarize's staple step targets .app bundles; stapling the disk
    // image is done explicitly so a change in its internals cannot silently drop
    // this. `stapler validate` immediately after is the proof, not a formality —
    // a staple that did not take is otherwise invisible until a user hits it.
    await run('xcrun', ['stapler', 'staple', dmg]);
    const out = await run('xcrun', ['stapler', 'validate', dmg]);
    if (!/The validate action worked/.test(out)) {
      throw new Error(`[notarize-dmg] staple did not take on ${dmg}: ${out}`);
    }

    const secs = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[notarize-dmg] notarised, stapled and validated in ${secs}s — ${dmg}`);
  }

  // No extra artifacts to publish; the .dmg files were modified in place.
  return [];
}
