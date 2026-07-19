---
id: phase-1-test-plan
title: Phase 1 — Verification Plan (spikes, acceptance, 3-OS matrix)
type: test
version: 0.2.1
status: draft
scope: How Phase 0 spikes and Phase 1 acceptance criteria are verified — spikes, per-feature acceptance, security tests, the 3-OS matrix, and irreversible release checkpoints
related: [phase-1-desktop-shell, phase-1-shell-architecture, phase-1-contracts, personalized-agent-desktop-app]
updated: 2026-07-20
---

# Phase 1 — Verification Plan

> Verifies [`phase-1-desktop-shell`](../impl/phase-1-desktop-shell.md) against the design in [`phase-1-shell-architecture`](../design/phase-1-shell-architecture.md) and the contracts in [`phase-1-contracts`](../interface/phase-1-contracts.md).

**Principle**: the architecture document tags claims `[V]`/`[E]`/`[C]`/`[?]`. Everything `[C]` or `[?]` that is load-bearing appears in §1 as a spike, because searching cannot settle it — only running it can.

---

## 1. Phase 0 spikes — gates before Phase 1

IDs match [`phase-1-desktop-shell`](../impl/phase-1-desktop-shell.md) §2. **SPIKE-05 and SPIKE-07 run first — they gate the whole architecture.**

| ID | Question | Method | Pass | Fails ⟹ |
|---|---|---|---|---|
| **SPIKE-05** | Does `AiSdkEngine` complete a chat turn on **all five** providers? | One round trip each on Anthropic, Bedrock (Claude), Azure OpenAI, Gemini, OpenAI, each with its own key/config | All five return a coherent turn | The multi-provider requirement fails; escalate before Phase 1 |
| **SPIKE-07** ✅ | Is the runtime provider-independent? | `npm run spike:07` — write memory + run a tool on the real dev engine, then run the same session on a second (mock) engine; read memory/history/executors back | All unchanged; only the answering model differs | The layering requirement fails; the store or MCP is wrongly key-scoped |
| **SPIKE-03** (a ✅ / b ⏳) | Is the gate sound on **both** engines? | **(a)** dev `ClaudeAgentSdkEngine`: `PreToolUse` fires on every call, deny survives `bypassPermissions`, `allowedTools` shadowing avoided — **`npm run spike:03`, 6/6**. **(b)** `AiSdkEngine`: execute-less tools surface every call to our loop; nothing auto-executes; a denied call never runs — **pending keys, rides on SPIKE-05** | Every tool call gated on both; deny blocks execution on both | The product's core feature fails |
| **SPIKE-04** | Does a custom Next server boot inside Electron and load from asar? | Package `asar: true`, install read-only, exercise a page that writes ISR + image caches | Boots, loads, writes only under `userData` | Fall back to `asar: false` or unpack `.next` |
| **SPIKE-01** | License scan | `license-checker` over the fork + five provider adapters' transitive tree | Upstream MIT; no GPL/AGPL downstream | Remove/replace the offending dependency |
| **SPIKE-02** | Fork boots with the swapped engine | `@surething/cockpit` boots; one chat turn through `AiSdkEngine` after the engine layer is replaced | Round trip succeeds | Re-evaluate the fork vs a thin self-built shell |
| **SPIKE-06** | *(conditional)* node-pty works packaged with `npmRebuild: false` | Only if a shell tool ships: package a minimal app that spawns a shell; install on a clean VM per OS | PTY opens on all 3 OSes | Combines the asar path bug, Windows `conpty/` layout, and `spawn-helper` exec-bit/signing — expect iteration |
| **SPIKE-08** | Dev engine parity | `ClaudeAgentSdkEngine` on local OAuth (no key) runs the same runtime — same gate, executors, memory, MCP — with the seven divergence points normalized | Same observable behavior as `AiSdkEngine` for a scripted tool-using turn | Drop the dev engine, or widen the normalization layer |

### 1.1 Design claims to settle during Phase 1

Not release gates, but each is an unverified assumption.

| Question | Minimal check | Why it matters |
|---|---|---|
| Which Electron major shipped async `safeStorage`? | `typeof safeStorage.encryptStringAsync` on the target version | Determines whether `await` can be written into the credential path |
| Do all five AI SDK adapters surface tool calls identically for our execute-less loop? | Run SPIKE-03b against each provider adapter, not just the mock | The gate must behave the same on every provider; core-side behavior is `[V]` but per-provider normalization is `[?]` until run live |
| Does `npm pack` of any provider adapter pull a native transitive dependency? | Inspect the five adapters' dependency trees | Would reintroduce an asar-unpack concern the pure-JS assumption rules out |
| Does electron-builder cross-build `--universal`/`--x64` on an arm64 macOS runner? | Run it; watch for the "same in both x64 and arm64" asar-merge error | Known-fragile — now only if node-pty ships. Hard deadline: Intel runners retire |
| Does Next write outside the configured cache dir? | Package, install read-only, exercise ISR + images, watch with `fs_usage`/Process Monitor | Read-only-install failures surface only after install |
| Does AppImage build on a macOS host? | Run it | Only the Docker path is documented |

---

## 2. Acceptance tests per feature

| Feature | Test | Pass |
|---|---|---|
| F1-01 | Build from a clean clone; inspect the lockfile and the engine seam | Builds; AI SDK minor pinned; engine swappable behind one interface |
| F1-02 | Launch the packaged app on each OS | Single executable starts; webview loads `127.0.0.1` |
| F1-03 | Enumerate reachable routes in the packaged build | Removed feature routes 404; no `bash` or extension-control surface reachable |
| F1-04 | Store a key per provider, restart, chat on **two** providers | Keys survive restart; chat succeeds on ≥2; **on Linux, `basic_text` produces a visible warning, not a silent store**; no layer but the engine reads a key |
| F1-05 | Chat, quit, relaunch, resume; switch provider mid-session | Conversation + memory restore from SQLite; switching provider leaves history/memory unchanged |
| F1-06 | Hand the installer to a non-developer on a machine with no `claude` CLI | Completes install → key → first reply unaided, no terminal |
| F1-07 | Run several turns | Per-session cost from engine usage displayed and plausible |
| F1-08 | Add two providers and one MCP server | Both providers complete a turn; the MCP tool is callable **through the gate** (`gate_request` observed); loaded via `listTools()`, not auto-executed |
| F1-09 | Publish n+1; check from n | Applies on Windows and Linux; unsigned macOS reports `unsupported` and offers a download |
| F1-10 | Tag a release | NSIS `.exe`, `.dmg`, `.AppImage`, `.deb` all produced |

---

## 3. Security tests

Not optional hardening. The design cites a CVSS 8.8 CVE of exactly this shape in Anthropic's own VS Code extension, so each control gets a negative test.

| Control | Negative test | Expected |
|---|---|---|
| Host validation | Request the local server with a foreign `Host` header | 403 |
| Origin validation | WebSocket upgrade with a foreign `Origin` | Rejected |
| Bind address | `netstat`/`lsof` while running | Bound to `127.0.0.1` only, never `0.0.0.0` |
| Session token | Request without the per-launch token | Rejected |
| Port scanning | A page probing the local port range without a token | No route responds usefully |
| Renderer isolation | Attempt `require` from the renderer | Fails; `contextIsolation` and `sandbox` on |
| IPC sender check | Invoke a handler from a non-allowlisted frame | Rejected |
| Credential at rest | Inspect the stored blob | Not plaintext; on a `basic_text` Linux box, the app warned |
| Key isolation | Trace which modules read a provider key | Only the engine's provider construction; never the renderer, logs, or the profiles file |

**Gate soundness regression** — run against **both engines** on every SDK bump, since these are behavioral properties of the engine:

1. A tool call is surfaced to the gate and does **not** execute until `allow` (AI SDK: execute-less loop; Agent SDK: `PreToolUse` fires first).
2. `deny` blocks execution; the model receives a denial result, not a success.
3. `allow` with rewritten input runs the executor on the rewritten input.
4. No auto-execution path bypasses the gate: AI SDK MCP tools loaded via `listTools()`/`callTool()` (not `tools()`); Agent SDK tool never in `allowedTools`; no provider-side server-executed tools enabled.
5. If the gate cannot be attached, the session refuses to start and surfaces `GATE_UNSOUND`.

---

## 4. Platform matrix

| | Windows 11 | macOS (arm64) | macOS (x64) | Ubuntu 24.04 | Ubuntu (tiling WM) |
|---|---|---|---|---|---|
| Install and launch | ✅ | ✅ | ⚠️ cross-build unverified | ✅ | ✅ |
| node-pty round trip *(if shipped)* | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Credential storage | ✅ DPAPI | ✅ Keychain | ✅ | ✅ libsecret | ⚠️ **expect `basic_text`** |
| Auto-update | ✅ unsigned | ❌ until signed | ❌ | ✅ AppImage/deb | ✅ |
| Sandbox launch | ✅ | ✅ | ✅ | ⚠️ **AppImage needs `--no-sandbox`; prefer `.deb`** | ⚠️ |

The two ⚠️ Linux cells are expected, not bugs to fix in Phase 1 — they are why `.deb` ships alongside `.AppImage` and why the credential path must warn rather than fail silently. **Test on a tiling WM specifically** — it reproduces the `basic_text` fallback.

---

## 5. Release checkpoints — irreversible decisions

Not tests. Decisions that cannot be undone after shipping, so they get a recorded sign-off before the release that locks them in.

| Checkpoint | Before | Requirement | Why it is irreversible |
|---|---|---|---|
| **macOS signing identity** | First macOS release | Developer ID Application certificate obtained; the exact identity recorded in the repo | Squirrel validates every update against the **running app's** designated requirement. A later cert rotation strands every installed user — and unlike Windows `publisherName`, there is no array to list old and new identities in |
| **Windows publisher identity** | First signed Windows release | If moving unsigned→signed or changing cert, list **both** old and new `publisherName` values | Omitting the previous name breaks updates for users on the older build. Recoverable, unlike macOS — but only if planned before the switch |
| **AI SDK version pin** | Each SDK bump | Gate soundness regression (§3) green on both engines; five-provider smoke test green | An adapter change can silently alter tool-call surfacing or a provider's behavior |

---

## 6. Definition of Done for verification

Phase 1 is verified when:

- All Phase 0 spikes have run and their results are recorded in the correction log of [`phase-1-desktop-shell`](../impl/phase-1-desktop-shell.md) — including failures.
- Every acceptance test in §2 passes on Windows and macOS (Linux may lag, per the phase DoD).
- Every security test in §3 passes, and the gate soundness regression is wired into CI against both engines.
- Each `[?]` claim in the architecture document is resolved to `[V]`/`[E]`, or re-marked as an accepted risk with an owner.
