# Phase 2 / 2.5 착수용 구현 계획 — 도구 실행 게이트와 하네스 실행

> 상태: 초안(2026-07-25). Phase 1.6까지 끝낸 시점에 썼다.
> 목표: "관측하고 등록하고 주입하는" 단계에서 "실제로 도구를 실행하고, 사람이 승인하고, 서브에이전트를 오케스트레이션하는" 단계로 넘어간다.

## 진행 상황 (2026-07-25 갱신)

- **M1 ✅** PolicyStore, realPolicy, 게이트 배선, 권한 설정 UI. (naby 45cc3b8 / cockpit f20cbf8)
- **M2 ✅** 사람 승인 브리지 — ask에서 턴을 멈추고 인라인 프롬프트를 띄운다. globalThis 레지스트리를 쓰고 abort와 TTL도 처리한다. (naby 668bf3c / cockpit b78651d)
- **M3 ✅** 스킬 자동 주입을 셸에 연결하고, 도구를 가진 스킬의 toolRef를 검증한다. (naby 61532b8 / cockpit e3d9e5f)
- **M4 진행 중** 서브에이전트. **dev-claude는 네이티브 `agents` 매핑까지 끝냈다**(모델이 게이트를 통과하는 Task로 위임한다). **남은 것(M4b): ai-sdk 쪽 수동 `naby_delegate`**(중첩 세션)와 실제 위임 라이브 검증.
- 별건(dormant): 메모리 자동 주입도 셸에 연결되지 않았다. 스킬과 같은 상태다.

---

## 0. 현재 상태 (근거)

| 구성 | 위치 | 현 상태 |
|---|---|---|
| 게이트 seam | `src/runtime/engine.ts:44-48` — `Gate = (ToolCall) => Promise<GateDecision>`, `GateDecision = {allow, input?} \| {deny, reason}` | **async**라 사람 승인을 await할 수 있다 |
| 게이트 구현 | `src/runtime/gate.ts` `makeGate(policy)` + `phase1HarnessFloor()` | 안전 바닥. 읽기 전용·위임·스킬·런타임 툴은 allow, 변형과 실행(Bash/Write/Edit…)은 **기본 deny** |
| **실제 턴 배선(교체점)** | shell `engines/naby.ts:523-527` — `makeGate(allowChanges ? ()=>allow-all : phase1HarnessFloor(...))` | ⚠️ **기본값(allowChanges ON)이 그냥 allow-all이고** floor는 OFF일 때만 걸린다. 이 **삼항이 곧 "그냥 허용"**이다. Phase 2가 여기를 교체한다 |
| 게이트 결정 타입 | `engine.ts:44-46` — `{allow, input?} \| {deny, reason}`. **`'ask'`가 없다** | 게이트가 async라 UI를 await하면 되므로 타입을 늘리지 않아도 된다(원하면 `'ask'`를 넣을 수는 있다) |
| 감사 로그 | `makeGate` 로그(`gate.ts:40-47`)는 **메모리와 console에만** 남고, `onGateDecision`은 프로덕션(`naby.ts:821`)에 **연결되지 않았다** | ⚠️ Phase 2 감사 추적은 이 로그를 **디스크에 남겨야** 한다(store 메서드 신설) |
| 턴 루프와 멈추는 지점 | ai-sdk `ai-sdk-engine.ts:463`(자체 루프의 `await input.gate(call)`) · claude `claude-agent-sdk-engine.ts:796`(PreToolUse hook) | **두 엔진 모두** 게이트를 await하므로 승인을 기다릴 지점이 이미 있다 |
| 도구 조립 | shell `engines/naby.ts:475-481` — `toolSchemas=[...builtin,...mcp]`, `executors={...builtin,...mcp}` | 여기에 스킬과 서브에이전트 도구를 합친다 |
| toolRefs | `store.ts:420,427` `skill.toolRefs?:string[]`, `subagent.toolRefs?:string[]` | **저장만 하고 해석하는 코드가 없다** |
| 스킬 배제 | `skill-inject.ts:70-74` `isInstructionOnly` — toolRefs가 있으면 주입에서 빼고 `excludedForTools`로 센다 | Phase 2.5에서 실행한다 |
| 서브에이전트 실행 | 없다. `framePersona`(shell `slashCommands.ts`)로 페르소나만 주입한다. SDK `Task`만 있다(`claude-agent-sdk-engine.ts`) | Phase 2.5에서 실제로 띄운다 |
| MCP 승인 패턴(참고용) | `naby_add_mcp` → status:'proposed' → `POST /api/naby {mcp.approve}` → enabled (`NabyProviderSetup`) | UI **모양**은 재사용한다. 다만 턴 중간을 막지는 않는다 |

핵심은 이렇다. **아키텍처가 Phase 2를 "정책 한 곳만 교체하면 되는" 모양으로 만들어 뒀다.** 어려운 쪽은 정책 자체가 아니라, 스트리밍이 흐르는 턴 중간에 **사람 승인을 기다리며 멈추는** 브리지다.

---

## Phase 2 — 실제 승인·정책 게이트

### P2 목표
`phase1HarnessFloor`를 실제 정책으로 교체한다.
1. **저장된 규칙**으로 프롬프트 없이 allow/deny를 결정한다(스코프 × 도구).
2. 규칙이 없는 위험한 호출은 **사람에게 묻는다**(허용·거부 + "이 프로젝트에서 항상 허용").
3. 결정을 **기억한다**(규칙으로 저장) + 감사 로그를 남긴다.

### P2 구성요소

**(1) PolicyStore** — store 슬라이스를 새로 만든다(memory·harness 스코프 패턴을 그대로 따른다)
- 테이블 `policy_rules(scope, scopeKey, tool_pattern, effect, created_at)`, `effect ∈ allow|deny|ask`.
- 메서드 `listPolicyRules(scope,scopeKey)`, `putPolicyRule(...)`, `removePolicyRule(id)`.
- 스코프 우선순위는 project > user > org로 기존 관례를 따른다.
- `tool_pattern`은 이름 그대로 쓰거나 `mcp:<server>/*` 글롭을 쓴다. `mcp__…__` 접두를 떼고 맞춘다.

**(2) realPolicy** — `src/runtime/policy.ts`(신규)에 `DecisionPolicy`를 구현한다. 교체 지점은 shell `engines/naby.ts:523-527`의 삼항(지금은 allow-all)이다.
```
realPolicy({ store, scope, scopeKey, requestApproval, safeDefaults })
```
- 규칙을 찾아 allow나 deny면 바로 반환한다.
- 읽기 전용 안전셋(`OBSERVATION_BUILTINS` 재사용)은 기본 allow다.
- 나머지(변형·실행·미지정)는 `await requestApproval(call)`로 물어 `{allow|deny, remember?}`를 받는다. 게이트가 async라 `ai-sdk-engine.ts:463`과 `claude-agent-sdk-engine.ts:796`에서 자연스럽게 멈춘다.
- `requestApproval`이 없으면(headless나 CLI) **`phase1HarnessFloor`로 물러난다**(안전하게 deny). 게이트를 거치지 않은 실행은 절대 없다.
- **감사 추적**: `makeGate` 로그(`gate.ts:40-47`)를 새 `store.appendGateDecision(...)`으로 저장한다. 지금 연결되지 않은 `onGateDecision`(`naby.ts:821`)을 배선한다. MCP 도구도 Executor라서 자동으로 게이트 대상이 된다.

**(3) 승인 브리지 — 여기가 어렵다.** 비동기 게이트를 UI까지 왕복시켜야 한다.
- 런타임에 `ApprovalController`를 둔다. `pending: Map<toolCallId, resolve>`를 갖고, `requestApproval(call)`이 이벤트를 방출하며 대기 Promise를 반환한다. 게이트가 이 Promise를 await하면 **그 도구 호출 지점에서 턴이 자연히 멈춘다.**
- 스트림: `EngineEvent {kind:'approval_request', toolCallId, toolName, input}`을 새로 만들어 **게이트를 await하기 바로 전에** 방출한다(`engine.ts:170-226` 유니온에 추가). shell `onEvent` 스위치(`naby.ts:672`)에서 새 RunEvent로 번역해 클라이언트 프롬프트를 띄운다. 최종 allow/deny는 기존 `gate_result` 이벤트로 UI가 다시 맞춘다.
- 해소 엔드포인트: `POST /api/naby {action:'approval.resolve', toolCallId, decision, remember?}`를 MCP action 유니온(`naby.ts:319-326`) 옆에 추가해 pending을 resolve한다. `remember`가 있으면 `putPolicyRule`을 부른다.
- UI: 승인 프롬프트(모달이나 칩)에 Allow / Deny / "이 프로젝트에서 항상 허용"을 둔다. `mcp.approve`(`api/naby.ts:474-486`)와 `NabyProviderSetup`의 승인 버튼 **모양을 재사용한다.** 다만 MCP는 턴 밖에서 일어나고 여기서는 **진행 중인 턴을 막는다**는 점이 다르다.
- 견고성: pending에 TTL을 둔다(예: 5분). 만료되면 deny한다. 탭을 닫거나 턴을 멈추면(`session.ts:289` abort) deny하고, 세션을 이어받을 때 pending을 다시 방출한다.

**(4) Settings — 권한 섹션**
- 지금의 `AllowChangesToggle`(전역 on/off)을 **도구별·스코프별 규칙 목록**으로 넓힌다. SettingsModal에 `permissions` 섹션을 새로 만들고 기존 패턴을 따른다. 규칙을 보고, 지우고, 켜고 끌 수 있게 한다.

### P2 마일스톤
- **M1**: PolicyStore + realPolicy(승인 브리지 없이 규칙과 안전 기본값만) + Settings 규칙 목록. 바닥을 규칙 기반으로 교체한다.
- **M2**: 승인 브리지(approval_request 이벤트 + resolve 엔드포인트 + UI 프롬프트 + remember). 사람이 개입한다.

### P2 검증
- 스파이크를 확장한다(`spike-03`, `03b` 게이트). 승인으로 allow, deny, remember 세 경우를 본다. `makeGate` 로그로 "게이트가 실행 전에 봤다"를 계속 확인한다.
- 서브에이전트 내부 호출도 게이트를 통과하는지 본다(기존 `spike-subagent-gate` 회귀).

---

## Phase 2.5 — 도구를 가진 스킬과 서브에이전트 오케스트레이션

### A. 도구를 가진 스킬 실행

**toolRef 문법을 정하고 문서화한다**(신규): `builtin:Read` | `mcp:<server>/<tool>` | `runtime:fetch_url`.

**resolveToolRefs(refs, available)** — `src/runtime/harness-tools.ts`(신규)
- refs를 이번 턴에 쓸 수 있는 도구(builtin·mcp·runtime)에 맞춰 `{schemas, executors}` 부분집합을 만든다.
- 해석하지 못한 ref가 있으면 스킬 **지시문은 주입하되** 빠진 도구를 세어 로그에 남긴다. 증상 없이 반쪽만 실행하는 일은 만들지 않는다(기존 원칙).

**주입 변경** — `skill-inject.ts`
- 배제 논리를 뒤집는다. `selectSkillsForInjection`의 `excludedForTools` 필터(`skill-inject.ts:128-130`)를 반대로 돌려, 관련 있고 켜져 있으며 도구를 가진 스킬이면 (1) 지시문을 주입하고 (2) `resolveToolRefs` 결과를 턴 toolset에 합친다.
- 합치는 지점은 shell `engines/naby.ts:475-481`(`toolSchemas=[...builtin,...mcp]`)이다. 합쳐진 도구도 **전부 Phase 2 게이트**를 지난다.

### B. 서브에이전트 오케스트레이션 (엔진마다 다르게)

**dev-claude (Agent SDK)** — 네이티브를 쓴다
- naby subagent(kind='subagent')를 SDK `query` options의 `agents` 정의로 매핑한다: `{systemPrompt, model?, allowedTools=resolveToolRefs}`. 매핑 지점은 `claude-agent-sdk-engine.ts`의 QueryOptions 빌더(127~166줄 근처)다.
- SDK `Task` 툴이 띄우고, **PreToolUse 게이트가 서브에이전트 안까지 닿는다**(검증했다). 게이트 작업을 더 할 필요가 없다.

**ai-sdk (metered·ChatGPT)** — 직접 위임한다
- 런타임 도구 `naby_delegate(name, task)`를 만든다. subagent의 systemPrompt, toolRefs로 제한한 toolset, model로 **중첩 세션**을 돌리고 최종 텍스트를 반환한다.
- 깊이는 중첩 위임 1단계까지만 허용하고 모든 호출을 게이트에 태운다. `runSubagent()`는 `runTurn`을 감싸는 얇은 래퍼다.

**"/" 동작 승격**
- Phase 2.5가 켜지면 `/subagent`(또는 `@subagent`)가 실제 위임을 부른다. 실행할 수 없을 때는 `framePersona`(`slashCommands.ts:313-317`) 폴백을 그대로 둔다.
- `NabyHarnessReview`의 `needsPhase25` 배지를 없애거나 켠다.

### P2.5 마일스톤
- **M3**: toolRef 문법, `resolveToolRefs`, 도구를 가진 스킬의 주입과 도구 합류.
- **M4**: 서브에이전트. dev-claude 네이티브 매핑을 먼저 하고, 그다음 ai-sdk `naby_delegate`를 만든다.

### P2.5 검증
- `spike-skill-inject`를 확장한다. 도구를 가진 스킬이 지시문과 도구를 함께 들여오는지, 해석 못 한 ref를 세는지 본다.
- `spike-subagent-gate`와 `spike-harness-visibility`를 확장한다. naby subagent가 toolRefs 제한 안에서 위임하는지, 게이트가 내부까지 닿는지, deny가 유지되는지, 깊이 제한을 지키는지 본다.

---

## 순서 · 위험 · 작업량

**권장 순서**: M1 → M2 → M3 → M4. 각각 따로 배포하고 검증할 수 있다.
- M1과 M2(Phase 2)를 먼저 한다. 실행을 열어 주는 스킬과 서브에이전트는 반드시 실제 게이트 뒤에 있어야 한다.

**위험**
- 승인 브리지가 스트림 중간을 막는 일(타임아웃, 탭 종료, 세션 이어받기). pending TTL, 연결이 끊기면 deny, 재방출로 줄인다.
- ai-sdk 서브에이전트는 루프를 직접 돌려야 해서 dev-claude 네이티브보다 일이 많다.
- toolRef 문법은 하네스 세트를 옮겨 쓰는 데 영향을 준다. 처음에 확정하고 문서에 남긴다.

**작업량 예상(어림)**: M1은 작다. M2는 중간이다(브리지와 UI). M3은 중간, M4는 중간에서 크다(엔진마다 따로 만든다). 스파이크를 먼저 쓰는 방식을 권한다.

**착수 전에 정해야 할 것**
- 승인 UI를 어디에 둘지: 채팅 인라인 대 전역 모달.
- 새 프로젝트의 기본 정책 강도: 변형·실행을 기본 ask로 둘지 기본 deny로 둘지.
- toolRef 문법 최종형.
