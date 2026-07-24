---
id: chatgpt-oauth-dev-provider
title: ChatGPT Subscription-OAuth — Dev-Only Provider (excluded from official distribution)
type: impl
version: 0.1.1
status: draft
scope: Adding a ChatGPT (OpenAI) subscription-OAuth provider that answers turns via a signed-in ChatGPT Plus/Pro subscription instead of a metered API key — DEV/TEST ONLY, flag-sealed out of official builds exactly like the Claude Agent SDK. Covers the ToS verdict that makes this dev-only, the AiSdkEngine custom-transport integration at the provider-independent engine seam, the OAuth/token-vault/refresh tasks, and why Google Gemini is excluded entirely.
related: [personalized-agent-desktop-app, phase-1-contracts, phase-1-shell-architecture, phase-1-desktop-shell]
updated: 2026-07-24
---

# ChatGPT Subscription-OAuth — Dev-Only Provider

> Adds a provider that answers on a **signed-in ChatGPT subscription** (no API key, no per-message charge), the OpenAI analogue of the dev `ClaudeAgentSdkEngine`. **Dev/test only** — flag-sealed out of official distribution, same discipline as the Agent SDK ([`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md) §3.3/§6). Product concept and auth model live there; provider config shape in [`phase-1-contracts`](../interface/phase-1-contracts.md) §4.

## 1. Why dev-only, and why not Gemini — the ToS verdict

Owner asked (2026-07-23) to add ChatGPT and Gemini as OAuth subscription-reuse providers, "openclaw 방식" — reuse a subscription like the Agent SDK reuses a Claude sign-in. Research + **first-source verification** produced a hard split:

- **Google Gemini — EXCLUDED (explicitly prohibited).** The gemini-cli official ToS (`docs/resources/tos-privacy.md`, verified by direct fetch) names it: *"Directly accessing the services powering Gemini CLI … using third-party software … **(for example, using OpenClaw with Gemini CLI OAuth) is a violation** … grounds for suspension or termination of your account."* Google cites the exact tool the owner referenced. → **Do not implement Gemini OAuth in any build.** Keep the existing Gemini **API-key** path (AiSdkEngine, `kind:'google'`).
- **OpenAI ChatGPT — GREY ZONE → dev-only.** Codex CLI officially supports "Sign in with ChatGPT" for personal use, but third-party app reuse of that OAuth is neither clearly permitted nor clearly forbidden (OpenAI policy page bot-blocked; openclaw's "OpenAI allows it" is its own unverified claim). Same risk class Naby already handled for the Agent SDK. → **implement, but flag-sealed dev/test only**; never bundle into an official/public build until OpenAI grants written permission.
- **`openclaw`** is a real project reusing all three subscriptions — its existence is not proof of legality; Google cites it as the violation example.

Full record: memory `naby-oauth-provider-tos`.

## 2. The dev-only seal (non-negotiable — design §3.3/§6)

- Production auth stays **one API key per provider** (§3.3). Subscription OAuth is a **dev/test convenience**, exactly like the Agent SDK's local Claude sign-in — it exercises the same provider-independent runtime at no metered cost.
- **Flag-sealed out of official builds.** Reuse the `NABY_BUNDLE_AGENT_SDK` pattern (`scripts/build-dist.mjs`): a single build-time flag decides whether the ChatGPT-OAuth path is present in a packaged app; **official/public distribution MUST NOT set it.** The OAuth code + any bundled endpoints are stripped from official artifacts.
- **Availability probe, not a build guess.** Like `isClaudeAgentSdkAvailable()` (`engines/select.ts`), the provider is *offered* only when the dev seal is open, so a shipped app never shows a choice it must not run.
- **No claim of endorsement.** UI copy must not imply OpenAI blesses this; it is a developer convenience with a stated ToS caveat.

## 3. Architecture — AiSdkEngine + custom transport (no engine change)

The engine seam is provider-independent: the gate, executors, memory injection, MCP, and tool schemas never see a provider or a credential — the only credential-dependent input is which model/transport answers a turn (contracts §2, design §3.4). So this attaches **without touching the runtime or the engine interface**:

- **`AiSdkEngine` extension, Option A (chosen).** A new provider kind (e.g. `openai-chatgpt-oauth`) constructs an OpenAI-compatible client with a **custom `fetch`** that (a) injects the OAuth `Authorization: Bearer <access>` (+ any account header), (b) points `baseURL` at the ChatGPT/Codex Responses backend, (c) refreshes the token on 401. Gate/executor/memory injection are unchanged. Rejected Option B (spawn the `codex` CLI as a subprocess) — heavier and binds us directly to the CLI's ToS surface.
- **Credentials in the OS keychain** via `safeStorage` (design §3.3, architecture §4.1) — the OAuth token set (`access`/`refresh`/`expires`/`accountId`) is a credential, stored and read exactly like an API key: never in a profile file, never in the renderer, read only when constructing the turn's transport.
- **CostBasis = 'subscription'** (like the dev engine) — a subscription turn shows no invented dollar bill (engines/select.ts `CostBasis`).

## 4. Tasks

> **Implementation status (2026-07-24) — core done, UI/e2e pending.** ✅ **Done + verified (pure/core, CO-01~05)**: the flag-sealed pure core `src/providers/chatgpt-oauth.ts` (PKCE S256, JWT account-id/exp extraction, query headers, `store:false` injection, expiry+skew, refresh rotation, `makeChatgptFetch` custom transport, `isChatgptOauthEnabled` seal); the `openai-chatgpt-oauth` provider kind wired into `registry.ts`/`resolve.ts`/`select.ts` (gated on the seal, `costBasis:'subscription'`); the Electron OAuth+vault module `electron/chatgpt-oauth.ts` (browser PKCE flow + localhost:1455 callback + `safeStorage` token vault + `ensureFreshToken`); the `build-dist.mjs` `guardChatgptOauthSeal()` build seal. Evidence: `npm run typecheck` clean, `spike:chatgpt` **10/10** (incl. the DEV-ONLY SEAL test — flag off ⇒ not enabled/available/described), all regression spikes green, `build:runtime` ok. 🔧 **Pending**: **CO-05 UI** (IPC wiring of the electron OAuth module + a sign-in/out + provider-switcher entry, offered only when the seal is open) and **CO-06** real-auth e2e (needs the owner's ChatGPT sign-in — not automatable).

| ID | Feature | Priority | Completion criteria |
|---|---|---|---|
| CO-01 | ChatGPT OAuth (PKCE) flow | Must | A dev user completes browser sign-in (authorize → localhost callback → code→token exchange) and a token set lands in the keychain; no secret in a file/renderer/log |
| CO-02 | Token vault + refresh | Must | Tokens stored via `safeStorage`; a 401/expiry triggers refresh transparently; logout clears them |
| CO-03 | AiSdkEngine custom transport | Must | A turn answers via the subscription with the Bearer/baseURL transport; gate/memory/MCP injection unchanged; streaming + usage intact; `costBasis:'subscription'` |
| CO-04 | Dev-only flag seal | Must | The whole path is absent from an official build (flag off); present only when the seal is open; `build-dist.mjs` strips it like the Agent SDK; a negative test confirms absence in a default packaged build |
| CO-05 | Provider config + selection UI | Should | `openai-chatgpt-oauth` selectable in the engine/provider switcher **only when the seal is open**; a clear "dev only / subscription / ToS caveat" label; sign-in/out entry point |
| CO-06 | Real-auth verification | Must | An actual ChatGPT sign-in answers a turn end-to-end (requires the owner's ChatGPT account — cannot be fully automated) |

## 5. Risks

- **ToS grey zone (OpenAI).** May become prohibited (as Google did for Gemini). → dev-only seal contains the blast radius; if OpenAI clarifies against it, the flag stays permanently off and the code path is removed. Never ship to end users on assumption.
- **OAuth endpoint drift.** The ChatGPT/Codex OAuth + Responses endpoints are not a stable public API. → isolate them behind the transport; a break disables the dev provider only, never production (API-key paths untouched).
- **Do not regress the metered path.** The five API-key providers (incl. Gemini `kind:'google'`) are unchanged; this is purely additive behind the seal.

## 6. Open questions

- Exact OpenAI OAuth authorize/token endpoints, scopes, and Responses base URL to target (derive from Codex's public sign-in flow; treat openclaw's implementation as a reference, not authority).
- Whether the transport speaks the OpenAI Responses API shape or a Chat Completions shape, and how that maps onto the AI SDK OpenAI adapter's expectations.
- Whether to also seal it behind a runtime env (`NABY_ENGINE`-style) in addition to the build flag, for defense in depth.

## 7. Explicitly out of scope

- **Google Gemini subscription OAuth** — prohibited (§1); never implemented.
- Any bundling of subscription OAuth into official/public distribution.
