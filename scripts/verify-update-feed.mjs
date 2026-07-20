// scripts/verify-update-feed.mjs
//
// F1-09 verification, and an honest accounting of its limits.
//
// WHAT THIS CAN PROVE WITHOUT A PUBLISHED RELEASE:
//   * `app-update.yml` exists inside the packaged app. This file, and ONLY this
//     file, determines where the updater looks. If it is missing, electron-updater
//     throws at the first check and auto-update is dead regardless of code.
//   * It names the right provider/owner/repo, i.e. the feed resolves to
//     github.com/leonardo204/naby and not to some default or leftover.
//   * NO CREDENTIAL IS EMBEDDED IN IT. This is the one design §6.3 warns about:
//     a private-repo feed forces a GH_TOKEN into the artifact where anyone who
//     unpacks it can read it. Public repo means the token must be absent, and
//     absent is checkable — so it is checked here rather than assumed.
//
// WHAT IT CANNOT PROVE, AND NOBODY SHOULD CLAIM IT DOES:
//   * That an update actually downloads and applies. That needs two published
//     releases and a machine running the older one. Until then the download and
//     apply paths are UNEXERCISED.
//   * On macOS, that Squirrel accepts the signature of a real update. That is
//     validated against the RUNNING app's designated requirement at update time,
//     which by definition cannot happen before a second signed release exists.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findAppUpdateYml() {
  const explicit = process.argv[2];
  if (explicit) return explicit;

  const releaseDir = resolve(root, 'release');
  if (!existsSync(releaseDir)) return undefined;

  const candidates = [];
  for (const entry of readdirSync(releaseDir)) {
    const dir = join(releaseDir, entry);
    // macOS: <out>/mac-arm64/Naby.app/Contents/Resources/app-update.yml
    if (entry.startsWith('mac')) {
      for (const inner of readdirSync(dir)) {
        if (inner.endsWith('.app')) {
          candidates.push(join(dir, inner, 'Contents', 'Resources', 'app-update.yml'));
        }
      }
    }
    // Windows/Linux unpacked: <out>/<platform>-unpacked/resources/app-update.yml
    candidates.push(join(dir, 'resources', 'app-update.yml'));
  }
  return candidates.find((p) => existsSync(p));
}

const ymlPath = findAppUpdateYml();
if (!ymlPath) {
  console.error(
    '[verify:feed] no app-update.yml found under release/.\n' +
      '              Build first: npm run electron:pack (or dist:mac).\n' +
      '              NOTE a `--dir` build DOES contain app-update.yml, so pack is enough.',
  );
  process.exit(1);
}

const raw = readFileSync(ymlPath, 'utf8');
console.log(`[verify:feed] ${ymlPath}\n--- app-update.yml ---\n${raw.trim()}\n`);

const get = (key) => {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : undefined;
};

const provider = get('provider');
const owner = get('owner');
const repo = get('repo');

const checks = [
  ['provider is github', provider === 'github', `provider=${provider}`],
  ['owner is leonardo204', owner === 'leonardo204', `owner=${owner}`],
  ['repo is naby', repo === 'naby', `repo=${repo}`],
  [
    'NO token embedded in the artifact',
    !/token:/i.test(raw),
    'a `token:` key here would be a published credential — design §6.3',
  ],
];

let failed = false;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!pass) failed = true;
}

if (!failed) {
  // The URL electron-updater will actually request on each platform.
  const base = `https://github.com/${owner}/${repo}/releases/download`;
  console.log(`\n[verify:feed] resolved feed base: ${base}/v<version>/`);
  console.log('[verify:feed]   macOS   -> latest-mac.yml   + <productName>-<version>-arm64-mac.zip');
  console.log('[verify:feed]   Windows -> latest.yml       + <productName> Setup <version>.exe');
  console.log('[verify:feed]   Linux   -> latest-linux.yml + <productName>-<version>.AppImage');
  console.log(
    '\n[verify:feed] UNPROVEN until a real release exists: download, signature validation on\n' +
      '              macOS, and the apply/restart path. Those need two published releases.',
  );
}

process.exit(failed ? 1 : 0);
