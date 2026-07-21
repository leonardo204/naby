---
id: phase-1-desktop-shell
title: Phase 1 — Chat-first Desktop Shell (incl. Phase 0 spike)
type: impl
version: 0.4.0
status: review
scope: Phase 0 feasibility spike and Phase 1 execution — Electron packaging of the OpenCockpit fork, chat-first trimming, the engine abstraction (AI SDK v7 prod + Agent SDK dev/test), per-provider API-key auth, provider-independent runtime scaffold, local SQLite sessions, and the Naby-store realignment (projects/sessions ownership + browsing-UI re-backing)
related: [personalized-agent-desktop-app, phase-1-shell-architecture, phase-1-contracts, phase-1-test-plan, phase-2-personalization-hitl]
updated: 2026-07-21
---

# Phase 1 — Chat-first Desktop Shell

> Execution plan for Phase 0 and Phase 1. Product concept and locked decisions live in [`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md); the technical design lives in [`phase-1-shell-architecture`](../design/phase-1-shell-architecture.md).

**Goal**: a 3-OS installable app in which **a non-developer can install → enter a provider API key → complete one chat round trip**, on at least two providers. Fork OpenCockpit for the UI shell, wrap it for desktop, trim to chat-first, and stand up the **provider-independent runtime** with a **swappable engine** beneath it.

**What Phase 1 delivers** (per the design's layer diagram): the shell, the **Agent Runtime scaffold** (session store, MCP registry, credential vault, and the gate *injection point* with a minimal always-prompt gate), the **`AiSdkEngine`** with all five provider adapters, and local **SQLite** persistence. The full tool executors, the rich risk-classified approval gate, and the metrics are Phase 2 → [`phase-2-personalization-hitl`](phase-2-personalization-hitl.md). The dev-only **`ClaudeAgentSdkEngine`** is optional in Phase 1 (see §8).

---

## 1. Correction log — assumptions falsified across v0.1→v0.3

The plan was rewritten twice as investigation invalidated earlier premises. Each entry changed a completion criterion; they are kept so the reasoning is auditable.

| # | Earlier assumption | Actual finding | Effect |
|---|---|---|---|
| 1 | Engine = Claude Agent SDK; multi-provider via a translating gateway | Serving GPT/Gemini/Azure to the Claude engine over a gateway is unreliable and unsupported (adaptive-thinking has no client kill switch for non-Claude aliases; tool-call translation bugs leave the gate hanging). | **Engine changed to Vercel AI SDK v7** with five first-party adapters; gateway path rejected |
| 2 | Auth is one org key (`ANTHROPIC_AUTH_TOKEN`) | Five providers have no common credential but an API key; the app just takes a key per provider, no role | F1-04 is per-provider key entry |
| 3 | The engine persists sessions (`~/.claude` JSONL); host stores only a session_id | AI SDK v7 does **not** persist sessions — we persist ourselves | F1-05 is a genuine local SQLite store, not ID bookkeeping — this *resolves* the earlier "SQLite is redundant" contradiction |
| 4 | Gate = Claude Code `PreToolUse` hook (or `canUseTool`) | With AI SDK v7 the gate is **our own loop over execute-less tools**; with the dev Agent SDK it is a `PreToolUse` hook. The gate is defined once in the runtime and attached per engine | F1's runtime scaffold owns the gate; §3 |
| 5 | Chat-first trimming is "hide / config flag" | Upstream has **7 feature packages**; chat-only means removing 6, and `feature-agent` imports back into `workspace`; project tabs are **iframes** | F1-03 is a subtraction, not a flag (§5) |
| 6 | MCP management is "port the tool-manager UX" | Upstream has **no MCP management** — it inherited MCP transitively from `~/.claude`. We own the MCP registry now | F1-08 is greenfield and provider-independent |
| 7 | Code signing can come after F1-09 | macOS auto-update **requires** signing; the cert choice is a **one-way door** | F1-09 splits by platform; macOS signing decided before first macOS release |
| 8 | We redistribute the Agent SDK's ~247 MB non-OSS engine binaries | With AI SDK v7 in production we **do not** bundle the Agent SDK. The dev engine uses it, but the dev build is never shipped | Redistribution concern gone from prod; installer shrinks; SPIKE narrows |

**Confirmed premises**: the OpenCockpit fork is MIT (SPIKE-01 part 1). A **spike harness at the repo root** (`src/`, run via `npm run spike:03` / `spike:07`) proves on the real dev engine that the `PreToolUse` gate fires on every tool call, its deny blocks execution and survives `bypassPermissions`, allow-with-rewrite runs on the rewritten input, and no `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning appears (SPIKE-03a, 6/6); and that switching engine mid-session leaves memory, history, and executors unchanged (SPIKE-07, 4/4). The prod-engine execute-less path (SPIKE-03b) rides on SPIKE-05 and awaits provider keys.

---

## 2. Phase 0 — feasibility spike (precondition)

Verify within one week; all blocking spikes pass before Phase 1. Fallback if a shell-packaging spike fails: a thin self-built Electron shell over the same runtime, dropping the OpenCockpit UI.

| ID | Spike | Pass condition | Status |
|---|---|---|---|
| SPIKE-01 | License scan | Upstream MIT confirmed **and** no GPL/AGPL in the transitive tree of the fork + AI SDK provider adapters | Upstream MIT **confirmed**; transitive audit outstanding |
| SPIKE-02 | Boot the fork locally | `@surething/cockpit` boots; one chat round trip after the engine is swapped to `AiSdkEngine` | Not run |
| SPIKE-03 | Gate soundness on both engines | **(a)** dev Agent SDK: a `PreToolUse` hook fires on every call, deny survives `bypassPermissions`. **(b)** prod AI SDK v7: execute-less tools surface every call to our loop; nothing auto-executes | **(a) proven in the harness** — 6/6 assertions on the real dev engine (surface-before-execute, deny blocks, allow, allow-with-rewrite, no shadow warning). **(b) pending provider keys** (rides on SPIKE-05) |
| SPIKE-04 | Electron wrapping PoC | Custom Next server boots in the Electron main process; webview loads `127.0.0.1` | Not run |
| SPIKE-05 | Five-provider round trip | `AiSdkEngine` completes a chat turn on **all five** providers via first-party adapters, each with its own API key | Not run — the multi-provider requirement rests on this |
| SPIKE-06 | node-pty in a packaged app *(only if a shell tool ships)* | If we ship a shell executor, a packaged app spawns a shell via node-pty on all 3 OSes with `npmRebuild: false` | Not run — conditional on the Phase 2 tool set |
| SPIKE-07 | Provider-independence | Switching provider (and switching to the dev engine) mid-session leaves memory, MCP, and session state unchanged — only the answering model differs | **Proven in the harness** — 4/4 assertions across a real-dev-engine → mock-engine switch on one session: memory/history carry over, executors are the identical instances, the store is keyed by session id only |
| SPIKE-08 | Dev engine parity | `ClaudeAgentSdkEngine` on local OAuth (no API key) runs the **same** runtime — same gate, executors, memory, MCP — with the seven divergence points normalized ([design](../design/personalized-agent-desktop-app.md) §3.4) | **Substantially proven** by SPIKE-03a + SPIKE-07 (the dev engine ran the shared runtime end to end); full seven-point normalization vs a live prod engine awaits SPIKE-05 |

**Sequencing**: SPIKE-05 and SPIKE-07 gate the whole architecture — run them first. SPIKE-04 gates packaging. SPIKE-06 is conditional. macOS signing (SPIKE for the notarization toolchain) is now a Phase 1 build-pipeline task, not an engine-binary risk.

---

## 3. What SPIKE-03 established — the gate is ours, attached per engine

The gate is not inherited from a vendor engine; it is our code, and each engine exposes a point to attach it. Both were verified by probe:

- **Prod (`AiSdkEngine`)**: tools are defined **execute-less** (schema only). AI SDK v7 then *surfaces* each tool call to the caller instead of running it — a documented loop-exit, not a hack. Our loop holds the call, runs the gate, executes the tool ourselves, appends the result, and calls the model again. Streaming, usage, and continuation are all intact. **MCP tools must be loaded via `listTools()` + `callTool()`**, not the default `tools()` (which binds an auto-executing `execute` that would skip the gate).
- **Dev (`ClaudeAgentSdkEngine`)**: built-ins stripped (`tools: []`); our tools exposed as an in-process `createSdkMcpServer` whose handler is our executor; the gate is a **`PreToolUse` hook** whose deny is authoritative even under `bypassPermissions`. **Never list a tool in `allowedTools`** — that auto-approves it and silently shadows the gate.

So the runtime defines the gate once; the engine boundary attaches it. Phase 1 must therefore stand up the gate *injection point* in the runtime, even though the rich gate UI and risk classification are Phase 2 — so that the one MCP tool exercised in F1-08 already passes through a minimal always-prompt gate. **No tool call is ever ungated, from Phase 1 onward.**

Two traps to encode now: never define an MCP tool with an auto-executing `execute` in prod, and never list a tool in `allowedTools` in the dev engine.

---

## 4. Phase 1 feature list

| ID | Feature | Description | Priority | Completion criteria |
|------|------|------|------|------|
| F1-01 | Fork + engine setup | Fork the shell; replace its engine layer with `AiSdkEngine`. **Pin the AI SDK minor** and keep the engine behind the runtime's engine interface | Must | Local build and boot succeed; lockfile pins the SDK; engine is swappable behind one interface |
| F1-02 | Desktop packaging | Electron shell hosts a **custom Next server** (not `output: 'standalone'` — mutually exclusive and standalone cannot run inside asar) and loads it in a webview | Must | App launches from a single executable on all 3 OSes |
| F1-03 | Chat-first trimming | Remove the 6 non-agent feature packages; untangle `feature-agent`'s back-imports into `workspace`; replace iframe project tabs. Close the `chrome-extension/` and `bash` API surfaces | Must | Non-developer screen exposes chat only; removed API routes return 404 |
| F1-04 | Per-provider API-key auth | Enter one API key per provider; store with Electron `safeStorage`; the key is read **only** by the engine to select the model | Must | Chat succeeds on ≥2 providers; no layer but the engine reads a key |
| F1-05 | Session persistence (SQLite) | Persist conversation transcripts, session index, and the memory store in local **SQLite** — the engine does not persist for us | Must | Sessions and memory restore after app restart |
| F1-06 | Onboarding wizard | First-run key entry, no terminal, no CLI | Must | Non-developer completes it unaided |
| F1-07 | Cost / usage display | Per-session cost from the engine's usage reporting | Should | Per-session cost displayed |
| F1-08 | Provider + MCP config | Provider selection across the five, and MCP server CRUD in the **provider-independent** registry; MCP tools loaded via `listTools()` and gated | Should | Two providers reachable; one MCP server connected and its tool callable **through the gate** |
| F1-09 | Auto-update | electron-updater on **Windows and Linux now**; macOS gated behind signing, no-ops (offers a download) until then | Should | Update applies on Win/Linux; macOS degrades to a download prompt |
| F1-10 | 3-OS builds | Per-OS CI matrix. **NSIS `.exe`** (electron-updater does not support MSI), `.dmg`, `.AppImage` **plus `.deb`** | Should | Artifacts produced on all 3 OSes |

Priority uses MoSCoW (**M**ust / **S**hould / **C**ould / **W**on't).

---

## 5. Modification principle — and the seam it requires

Chat-only requires removing six of seven feature packages, and the seam is not clean, so the "trim via flag" idea is narrowed:

- **Deletion is accepted for feature packages** — hiding six subsystems behind flags leaves their routes, dependencies, and attack surface in the build.
- **The engine layer is replaced, not tweaked.** The fork's Claude-Agent-SDK engine comes out; `AiSdkEngine` goes in behind the runtime's engine interface. Treat the fork as a **UI-shell dependency**, not an engine we co-develop.
- **Our runtime lives in a separate module** and exposes the **gate injection point** and the **engine interface**, because Phase 2's executors and the dev engine both plug into it. Establishing this boundary now avoids touching the merge-sensitive path twice.
- Upstream merges will be noisy (single-maintainer, near-daily commits) — keep the surface we touch small.

---

## 6. Definition of Done

- A non-developer completes **install → key entry → one chat round trip** without a terminal, on a machine with no `claude` CLI.
- **At least two providers** complete a chat turn through `AiSdkEngine`.
- If any tool (e.g. the F1-08 MCP tool) is callable, **every call passes the minimal gate** — no ungated execution.
- Switching provider mid-session leaves memory, MCP, and session state unchanged.
- Sessions and memory resume after restart.
- Windows and macOS installers produced (Linux may lag); auto-update on Windows and Linux; macOS signed or explicitly degraded.

---

## 7. Phase 1 risks

- **Packaging resistance** — verified early via SPIKE-04; fallback is a thin self-built shell over the same runtime.
- **macOS signing is a one-way door** — Squirrel validates updates against the running app's designated requirement, so a later cert rotation strands every installed user (no `publisherName`-style migration array as on Windows). Choose the Developer ID identity before the first macOS release.
- **node-pty packaging** *(only if a shell tool ships)* — `npmRebuild: false` keeps the N-API prebuilds, but `node-pty@^1.1.0` has **no Linux prebuild** (the 1.2.0-beta line does), and an open upstream asar path bug surfaces as a generic `posix_spawnp failed`.
- **Installer size** — much smaller than the Agent-SDK plan (no ~247 MB engine binary), but Electron + five provider SDKs is still substantial; keep delta updates working.
- **Provider parity** — five first-party adapters each track their provider independently; a per-provider smoke test in CI catches an adapter regression before release.
- **Localhost server exposure** — a local HTTP server in a desktop app is a proven CVE class, including in Anthropic's own VS Code extension (CVE-2025-52882: no auth, no Origin validation). Random ports are not a mitigation. Controls in [`phase-1-shell-architecture`](../design/phase-1-shell-architecture.md) §5.
- Cross-phase risks are in [`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md) §4.

---

## 8. Phase 1 open questions

- OS priority (Windows first?) and whether Linux ships in this phase.
- Whether `.deb` ships alongside `.AppImage` — the AppImage sandbox failure on Ubuntu 23.10+ makes it close to mandatory.
- **Whether `ClaudeAgentSdkEngine` (dev/test) ships in Phase 1 or stays a Phase-0 harness.** It is verified feasible on local OAuth at no metered cost, but every hour on the dev backend is not spent on the production one.
- Which of the five providers must pass F1-04's "≥2 providers" bar first (likely Anthropic + OpenAI).

Product-level open questions live in [`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md) §6.

---

## 9. Naby-store realignment — the store the UI reads (Phase A→E)

The Naby Layer owns projects, sessions, memory, and context (design §3.6). This realignment makes that real: today Naby's store is *written* every turn but is **invisible to the UI** (no API exposes `listSessions`/`getSession`/`deleteSession`), and every browsing screen reads the wrong layer — project list ← `~/.cockpit/projects.json`; per-project state ← `~/.cockpit/projects/<enc>/session.json`; SessionBrowser + ProjectSessionsModal ← provider-native `~/.claude/projects/*.jsonl`; Recent ← `~/.cockpit/state.json`; Pinned ← `~/.cockpit/pinned-sessions.json`. There is no Project entity in the store and no session↔project link. Phases B–E close this; **full A→E realignment is in scope for Phase 1.** Design §3.6, architecture §8, contracts §6.1/§8.

| Phase | Item | Description | Acceptance criterion |
|---|---|---|---|
| **A** | Baseline (done) | The Naby store exists and is written each turn (`sessions`/`messages`/`memory`/`usage`/`settings`/`mcp`), driver `node:sqlite`, `SCHEMA_VERSION = 2`. `SessionRef` has no `cwd`; there is no `projects` table. | Established — this is the starting point the realignment builds on. |
| **B** | Store schema + one-time import | Bump `SCHEMA_VERSION` 2 → 3. Add the `projects` table and `sessions.cwd`/`pinned`/`status` columns via an **additive, version-gated** migration (arch §8.1: `ADD COLUMN` runs only when `current < 3`, `IF NOT EXISTS` for the table, then stamp `user_version = 3`; no backfill). Implement the new `Store` ops (contracts §6.1): `listProjects`, `upsertProject`, `removeProject` (CASCADE), `touchProject`, `listSessionsByProject`, `setSessionProject`, `setSessionPinned`, `listPinnedSessions`. Import `~/.cockpit/projects.json` **once** into `projects` (idempotent, `settings`-flag guarded). | Opening an existing v2 DB upgrades to v3 with **no data loss**; the migration is idempotent across repeated opens. `removeProject(cwd)` deletes the project's sessions + their messages/memory/usage (a store test asserts zero orphans). The cockpit import runs once and re-running it changes nothing. `listProjects`/`listSessionsByProject`/`listPinnedSessions` return MRU order. |
| **C** | API re-backing per route | Re-implement `/api/projects`, `/api/project-state`, `/api/sessions/projects[/…]`, `/api/global-state` (recent), `/api/pinned-sessions`, and the session **transcript** route over the Naby store (contracts §8). Keep the **client** API surface (`fetchProjects`, `loadSessionsByProject`, …) unchanged — only the server handler's source moves. | Each route returns the same JSON shape the client already consumes, now sourced from `app.db`. The transcript view renders from `getMessages(sessionId)`. A test hitting each route asserts the response no longer depends on any `~/.cockpit/*` or `~/.claude/*` file (e.g. passes with those files absent). |
| **D** | Record cwd/project on session lifecycle | In `naby.ts`, on session **create** and **touch**, record the owning project: `touchProject(cwd)` and link the session (`setSessionProject`/`cwd` on create). Projectless sessions remain valid (`cwd` absent). | Creating/using a session in a working directory produces a `projects` row (or bumps its `last_opened_at`) and a session whose `cwd` points to it. Switching provider mid-session leaves `cwd`, messages, and memory unchanged (extends the existing provider-independence check). |
| **E** | Remove provider/cockpit direct reads from browsing UIs | Delete the direct-file reads from the browsing UIs: project list, per-project session state, SessionBrowser, ProjectSessionsModal, Recent, Pinned. They consume only the re-backed routes (Phase C). Provider dirs and `~/.cockpit/*` files remain on disk (engine-only per design §3.6) but are **no longer read by any session/project UI**. | A grep of the browsing UI code shows **no** reads of `~/.claude/projects`, `~/.cockpit/projects.json`, `~/.cockpit/state.json`, `~/.cockpit/pinned-sessions.json`, or `~/.cockpit/projects/<enc>/session.json`. With those files deleted, the session/project/recent/pinned screens still render from `app.db`. |

**Sequencing**: B before C (routes need the store ops), C before E (UIs need the routes before their direct reads are removed), D alongside C (so newly created sessions carry a `cwd` the routes can group by). Verification of B–E belongs in [`phase-1-test-plan`](../test/phase-1-test-plan.md).

---

## References

Numbering matches the canonical list in [`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md).

1. Surething-io (2026), cockpit — The open-source Claude Code GUI (MIT), https://github.com/Surething-io/cockpit
2. Vercel (2026), AI SDK — Providers and Models, https://ai-sdk.dev/docs/foundations/providers-and-models
3. Vercel (2026), AI SDK — Tool calling and tool approval, https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
6. getAsterisk (2026), opcode — AGPL License, https://github.com/getAsterisk/opcode
9. Anthropic (2026), LLM gateway configuration — non-Claude routing unsupported, https://code.claude.com/docs/en/llm-gateway
