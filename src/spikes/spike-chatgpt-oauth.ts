// src/spikes/spike-chatgpt-oauth.ts
//
// ChatGPT subscription-OAuth (dev-only) — pure-core verification (CO-01..05).
// Task/policy in ref-docs/specs/impl/chatgpt-oauth-dev-provider.md; the wire
// values in scratchpad/chatgpt-oauth-spec.md (verified against openai/codex +
// openclaw). This exercises everything testable WITHOUT a browser, a network,
// or safeStorage — the OAuth flow itself and the live query need the owner's
// real ChatGPT sign-in (CO-06) and cannot be automated.
//
//   (a) PKCE is S256 — challenge = base64url(sha256(verifier)), deterministic.
//   (b) account id / email / exp are read from the access-token JWT claims.
//   (c) query headers match the subscription backend contract (spec §4).
//   (d) store:false is forced into the JSON body (backend rejects store:true).
//   (e) expiry math — expires_in wins, JWT exp fallback, skew window.
//   (f) THE DEV-ONLY SEAL — with the flag off the provider is never enabled,
//       never available, and absent from describeProviders; on it flips.
//   (g) refresh ROTATES the refresh token; permanent failures are classified.
//   (h) the authorize URL carries the exact required query params.

import { createHash } from 'node:crypto';
import {
  generatePkce,
  base64UrlEncode,
  buildAuthorizeUrl,
  extractAccountId,
  extractEmail,
  extractExpiryMs,
  buildQueryHeaders,
  forceStoreFalse,
  expiresAtFrom,
  isTokenExpired,
  applyRefreshResponse,
  isPermanentRefreshFailure,
  isChatgptOauthEnabled,
  tokensFromExchange,
  CHATGPT_CLIENT_ID,
  CHATGPT_OAUTH_ENABLE_FLAG,
  type ChatgptOauthTokens,
} from '../providers/chatgpt-oauth.js';
import { isChatgptOauthAvailable } from '../engines/select.js';
import { describeProviders } from '../providers/registry.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, evidence: string): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}`);
  }
  console.log(`        ${evidence}`);
}

/** Build an unsigned JWT (header.payload.sig) with the given payload claims. */
function makeJwt(payload: Record<string, unknown>): string {
  const h = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const p = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

// -- (a) PKCE S256 ----------------------------------------------------------
{
  const fixed = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'); // 32 bytes
  const pkce = generatePkce(fixed);
  const expectedVerifier = base64UrlEncode(fixed);
  const expectedChallenge = base64UrlEncode(createHash('sha256').update(expectedVerifier).digest());
  const ok =
    pkce.method === 'S256' &&
    pkce.verifier === expectedVerifier &&
    pkce.challenge === expectedChallenge &&
    !/[+/=]/.test(pkce.challenge); // base64url, no padding
  check(
    '(a) PKCE S256 — challenge = base64url(sha256(verifier)), url-safe no-pad',
    ok,
    `method=${pkce.method} verifier=${pkce.verifier.slice(0, 12)}… challenge=${pkce.challenge.slice(0, 12)}… matches=${ok}`,
  );
}

// -- (b) JWT claim extraction ----------------------------------------------
{
  const exp = 2_000_000_000; // seconds
  const jwt = makeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-XYZ', chatgpt_account_is_fedramp: false },
    email: 'dev@example.com',
    exp,
  });
  const acct = extractAccountId(jwt);
  const email = extractEmail(jwt);
  const expMs = extractExpiryMs(jwt);
  const garbage = extractAccountId('not-a-jwt');
  const ok = acct === 'acc-XYZ' && email === 'dev@example.com' && expMs === exp * 1000 && garbage === null;
  check(
    '(b) JWT claims — account_id / email / exp read from access-token; garbage → null',
    ok,
    `account_id=${acct} email=${email} expMs=${expMs} garbage=${garbage}`,
  );
}

// -- (c) query headers ------------------------------------------------------
{
  const h = buildQueryHeaders({
    accessToken: 'ACCESS',
    accountId: 'acc-XYZ',
    platform: 'darwin',
    release: '24.5.0',
    arch: 'arm64',
    fedramp: true,
  });
  const ok =
    h['authorization'] === 'Bearer ACCESS' &&
    h['chatgpt-account-id'] === 'acc-XYZ' &&
    h['openai-beta'] === 'responses=experimental' &&
    h['originator'] === 'naby' &&
    h['user-agent'] === 'naby (darwin 24.5.0; arm64)' &&
    h['x-openai-fedramp'] === 'true';
  check(
    '(c) query headers — Bearer + chatgpt-account-id + OpenAI-Beta + originator + UA + fedramp',
    ok,
    JSON.stringify(h),
  );
  const noFed = buildQueryHeaders({ accessToken: 'A', accountId: 'B' });
  check(
    '(c2) non-fedramp omits x-openai-fedramp',
    noFed['x-openai-fedramp'] === undefined && noFed['authorization'] === 'Bearer A',
    `x-openai-fedramp=${noFed['x-openai-fedramp']}`,
  );
}

// -- (d) store:false injection ---------------------------------------------
{
  const withTrue = forceStoreFalse('{"model":"gpt-5-codex","store":true,"input":[]}');
  const parsed = JSON.parse(withTrue) as { store: boolean; model: string };
  const added = forceStoreFalse('{"model":"x"}');
  const parsedAdded = JSON.parse(added) as { store: boolean };
  const nonJson = forceStoreFalse('not json');
  const ok = parsed.store === false && parsedAdded.store === false && nonJson === 'not json';
  check(
    '(d) store:false forced into JSON body (backend rejects store:true); non-JSON untouched',
    ok,
    `wasTrue→${parsed.store} absent→${parsedAdded.store} nonJson="${nonJson}"`,
  );
}

// -- (e) expiry math --------------------------------------------------------
{
  const now = 1_000_000_000_000;
  const fromExpiresIn = expiresAtFrom({ expires_in: 3600 }, now);
  const jwt = makeJwt({ exp: (now + 7200_000) / 1000 });
  const fromJwt = expiresAtFrom({ access_token: jwt }, now);
  const fallback = expiresAtFrom({}, now);
  const expiredPast = isTokenExpired(now - 1, now);
  const withinSkew = isTokenExpired(now + 60_000, now); // 1 min ahead, skew 5 min → expired
  const fresh = isTokenExpired(now + 10 * 60_000, now); // 10 min ahead → fresh
  const ok =
    fromExpiresIn === now + 3600_000 &&
    fromJwt === now + 7200_000 &&
    fallback === now + 3600_000 &&
    expiredPast &&
    withinSkew &&
    !fresh;
  check(
    '(e) expiry — expires_in wins, JWT exp fallback, 1h default; skew window flags near-expiry',
    ok,
    `expiresIn=${fromExpiresIn - now} jwt=${fromJwt - now} fallback=${fallback - now} past=${expiredPast} skew=${withinSkew} fresh=${fresh}`,
  );
}

// -- (f) THE DEV-ONLY SEAL --------------------------------------------------
{
  const off: NodeJS.ProcessEnv = {};
  const on: NodeJS.ProcessEnv = { [CHATGPT_OAUTH_ENABLE_FLAG]: '1' };

  const enabledOff = isChatgptOauthEnabled(off);
  const enabledOn = isChatgptOauthEnabled(on);
  const availOff = isChatgptOauthAvailable(off);
  const availOn = isChatgptOauthAvailable(on);
  const inDescribeOff = describeProviders(off).some((p) => p.kind === 'openai-chatgpt-oauth');
  const inDescribeOn = describeProviders(on).some((p) => p.kind === 'openai-chatgpt-oauth');

  const ok =
    enabledOff === false &&
    enabledOn === true &&
    availOff === false &&
    availOn === true &&
    inDescribeOff === false &&
    inDescribeOn === true;
  check(
    '(f) DEV-ONLY SEAL — flag off ⇒ not enabled/available/described; flag on ⇒ present',
    ok,
    `enabled off/on=${enabledOff}/${enabledOn} available off/on=${availOff}/${availOn} described off/on=${inDescribeOff}/${inDescribeOn}`,
  );
}

// -- (g) refresh rotation + failure classification --------------------------
{
  const prev: ChatgptOauthTokens = {
    access_token: makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } }),
    refresh_token: 'OLD-REFRESH',
    expires_at: 0,
    account_id: 'acc-1',
  };
  const rotated = applyRefreshResponse(
    prev,
    {
      access_token: makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } }),
      refresh_token: 'NEW-REFRESH',
      expires_in: 3600,
    },
    1_000_000,
  );
  const kept = applyRefreshResponse(
    prev,
    { access_token: prev.access_token, expires_in: 3600 }, // no new refresh token → keep old
    1_000_000,
  );
  const ok =
    rotated.refresh_token === 'NEW-REFRESH' &&
    kept.refresh_token === 'OLD-REFRESH' &&
    isPermanentRefreshFailure('refresh_token_reused') &&
    isPermanentRefreshFailure('refresh_token_expired') &&
    isPermanentRefreshFailure(401) &&
    !isPermanentRefreshFailure('transient_blip') &&
    !isPermanentRefreshFailure(503);
  check(
    '(g) refresh ROTATES the refresh token (new wins, absent keeps old); permanent failures classified',
    ok,
    `rotated=${rotated.refresh_token} kept=${kept.refresh_token} reused=perm(${isPermanentRefreshFailure('refresh_token_reused')}) 401=perm(${isPermanentRefreshFailure(401)}) 503=perm(${isPermanentRefreshFailure(503)})`,
  );
}

// -- (h) authorize URL ------------------------------------------------------
{
  const url = new URL(
    buildAuthorizeUrl({
      challenge: 'CHAL',
      state: 'STATE',
      redirectUri: 'http://localhost:1455/auth/callback',
    }),
  );
  const q = url.searchParams;
  const ok =
    url.origin + url.pathname === 'https://auth.openai.com/oauth/authorize' &&
    q.get('response_type') === 'code' &&
    q.get('client_id') === CHATGPT_CLIENT_ID &&
    q.get('redirect_uri') === 'http://localhost:1455/auth/callback' &&
    q.get('code_challenge') === 'CHAL' &&
    q.get('code_challenge_method') === 'S256' &&
    q.get('state') === 'STATE' &&
    q.get('scope') === 'openid profile email offline_access' &&
    q.get('originator') === 'naby';
  check(
    '(h) authorize URL — endpoint + response_type + client_id + PKCE(S256) + redirect + scope + originator',
    ok,
    `client_id=${q.get('client_id')} method=${q.get('code_challenge_method')} scope="${q.get('scope')}"`,
  );
}

// -- exchange sanity (bonus) -----------------------------------------------
{
  const jwt = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-EX' } });
  const t = tokensFromExchange({ access_token: jwt, refresh_token: 'R', expires_in: 3600 }, 1_000_000);
  let threw = false;
  try {
    tokensFromExchange({ access_token: jwt } as never, 1_000_000); // no refresh_token
  } catch {
    threw = true;
  }
  check(
    '(i) tokensFromExchange derives account_id from access-token JWT; missing refresh_token throws',
    t.account_id === 'acc-EX' && t.refresh_token === 'R' && threw,
    `account_id=${t.account_id} refresh=${t.refresh_token} missingRefreshThrew=${threw}`,
  );
}

console.log('');
const total = passed + failed;
if (failed === 0) {
  console.log(`SPIKE-CHATGPT-OAUTH: ALL PASS (${passed}/${total})`);
  process.exit(0);
} else {
  console.log(`SPIKE-CHATGPT-OAUTH: ${failed} FAILED (${passed}/${total})`);
  process.exit(1);
}
