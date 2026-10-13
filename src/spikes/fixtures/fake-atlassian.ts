// src/spikes/fixtures/fake-atlassian.ts
//
// A LOCAL STAND-IN FOR ATLASSIAN'S REMOTE MCP AND ITS OAUTH SERVER
// (org-harness-sync §3.8, M3). Used by `spike:mcp-oauth`, `spike:org-harness-gate`
// and the shell's vitest — never by the app.
//
// The server itself is `fake-oauth-mcp.ts` in its `atlassian` shape, which
// answers DISCOVERY the way the live server did on 2026-10-08:
//   /.well-known/oauth-protected-resource          404
//   /.well-known/oauth-authorization-server/v1/mcp 404
//   /.well-known/oauth-authorization-server        200, issuer = the origin
//   401 from /v1/mcp: `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token"`
//                     with NO resource_metadata
// so a client that only works with protected-resource metadata fails here too.
// This file keeps the names the Atlassian callers import.

import {
  REDUCED_TOOL_NAMES,
  startFakeOAuthMcp,
  type FakeOAuthMcp,
  type FakeOAuthMcpOptions,
} from './fake-oauth-mcp.js';

export { REDUCED_TOOL_NAMES };

export type FakeAtlassianOptions = Omit<FakeOAuthMcpOptions, 'shape'>;
export type FakeAtlassian = FakeOAuthMcp;

export function startFakeAtlassian(opts: FakeAtlassianOptions = {}): Promise<FakeAtlassian> {
  return startFakeOAuthMcp({ ...opts, shape: 'atlassian' });
}
