# Phase 2 / 2.5 착수용 구현 계획 — 도구 실행 게이트 & 하네스 실행

> 상태: 초안 (2026-07-25). Phase 1.6까지 완료된 시점에서 작성.
> 목표: "관측·등록·주입까지"에서 "실제 도구 실행 + 인간 승인 + 서브에이전트 오케스트레이션"으로.

## 진행 상황 (2026-07-25 업데이트)

- **M1 ✅** PolicyStore + realPolicy + 게이트 배선 + 권한 설정 UI. (naby 45cc3b8 / cockpit f20cbf8)
- **M2 ✅** 인간 승인 브리지(ask→일시정지→인라인 프롬프트, globalThis 레지스트리, abort/TTL). (naby 668bf3c / cockpit b78651d)
- **M3 ✅** 자동 스킬 주입 셸 배선 + 도구 보유 스킬 toolRef 검증. (naby 61532b8 / cockpit e3d9e5f)
- **M4 ~** 서브에이전트: **dev-claude 네이티브 `agents` 매핑 완료**(모델이 gated Task로 위임). **남음(M4b): ai-sdk 수동 `naby_delegate`**(중첩 세션) + 실제 위임 라이브 검증.
- 별건(dormant): 메모리 자동 주입도 셸 미배선(스킬과 동일 패턴).

---

## 0. 현재 상태 (근거)

| 구성 | 위치 | 현 상태 |
|---|---|---|
| 게이트 seam | `src/runtime/engine.ts:44-48` — `Gate = (ToolCall) => Promise<GateDecision>`, `GateDecision = {allow, input?} \| {deny, reason}` | **async** → 인간 승인을 await 가능 |
| 게이트 구현 | `src/runtime/gate.ts` `makeGate(policy)` + `phase1HarnessFloor()` | 안전 바닥: read-only/위임/스킬/런타임툴 allow, 변형·실행(Bash/Write/Edit…) **deny-by-default** |
| **실제 턴 배선(교체점)** | shell `engines/naby.ts:523-527` — `makeGate(allowChanges ? ()=>allow-all : phase1HarnessFloor(...))` | ⚠️ **기본(allowChanges ON)은 bare allow-all**, floor는 OFF일 때만. 이 **삼항이 곧 "그냥 허용"**. Phase 2가 여기를 교체 |
| 게이트 결정 타입 | `engine.ts:44-46` — `{allow, input?} \| {deny, reason}`. **`'ask'` 없음** | async 게이트로 UI await → 타입 확장 불필요(원하면 `'ask'` 추가 가능) |
| 감사 로그 | `makeGate` 로그(`gate.ts:40-47`)는 **인메모리 + console만**; `onGateDecision`은 프로덕션(`naby.ts:821`)에서 **미배선** | ⚠️ Phase 2 감사추적은 이 로그를 **영속화**(신규 store 메서드) 필요 |
| 턴 루프 / 일시정지 지점 | ai-sdk `ai-sdk-engine.ts:463` (자체 루프 `await input.gate(call)`) · claude `claude-agent-sdk-engine.ts:796` (PreToolUse hook) | **두 엔진 모두** 게이트를 await → 승인 대기 지점이 이미 존재 |
| 도구 조립 | shell `engines/naby.ts:475-481` — `toolSchemas=[...builtin,...mcp]`, `executors={...builtin,...mcp}` | 여기에 스킬/서브에이전트 도구를 union |
| toolRefs | `store.ts:420,427` `skill.toolRefs?:string[]`, `subagent.toolRefs?:string[]` | **저장만, 해석 코드 없음** |
| 스킬 배제 | `skill-inject.ts:70-74` `isInstructionOnly` — toolRefs 있으면 주입 제외(`excludedForTools`) | Phase 2.5에서 실행 |
| 서브에이전트 실행 | 없음. `framePersona`(shell `slashCommands.ts`)로 페르소나 주입만. SDK `Task`만 존재(`claude-agent-sdk-engine.ts`) | Phase 2.5에서 실 스폰 |
| MCP 승인 패턴(재사용 참고) | `naby_add_mcp` → status:'proposed' → `POST /api/naby {mcp.approve}` → enabled (`NabyProviderSetup`) | UI **모양**은 재사용, 단 mid-turn 블로킹 아님 |

핵심: **아키텍처가 Phase 2를 "정책 교체 한 곳"으로 설계**해 둠. 난이도는 정책 자체가 아니라 **인간 승인을 스트리밍 턴 중간에 블로킹**하는 브리지에 있음.

---

## Phase 2 — 실제 승인/정책 게이트

### P2 목표
`phase1HarnessFloor`를 실 정책으로 교체:
1. **저장된 규칙**으로 프롬프트 없이 allow/deny (스코프×도구).
2. 규칙 없는 위험 호출 → **인간 승인**(허용/거부 + "이 프로젝트에서 항상 허용").
3. 결정 **기억**(규칙으로 영속) + 감사 로그.

### P2 구성요소

**(1) PolicyStore** — 새 store 슬라이스 (memory/harness 스코프 패턴 미러)
- 테이블 `policy_rules(scope, scopeKey, tool_pattern, effect, created_at)`; `effect ∈ allow|deny|ask`.
- 메서드: `listPolicyRules(scope,scopeKey)`, `putPolicyRule(...)`, `removePolicyRule(id)`.
- 스코프 우선순위 project > user > org (기존 관례).
- `tool_pattern`: bare 이름 or `mcp:<server>/*` 글롭. 정규화는 `mcp__…__` 스트립 후 매칭.

**(2) realPolicy** — `src/runtime/policy.ts` (신규), `DecisionPolicy` 구현. 교체 지점은 shell `engines/naby.ts:523-527`의 삼항(현재 allow-all).
```
realPolicy({ store, scope, scopeKey, requestApproval, safeDefaults })
```
- 규칙 조회 → allow/deny면 즉시 반환.
- read-only 안전셋(`OBSERVATION_BUILTINS` 재사용) → 기본 allow.
- 그 외(변형·실행·미지정) → `await requestApproval(call)` → {allow|deny, remember?}. (게이트가 async라 `ai-sdk-engine.ts:463`/`claude-agent-sdk-engine.ts:796`에서 자연 일시정지.)
- `requestApproval` 없음(headless/CLI) → **`phase1HarnessFloor`로 폴백**(안전 deny). ← 절대 ungated 실행 안 함.
- **감사추적**: `makeGate` 로그(`gate.ts:40-47`)를 신규 `store.appendGateDecision(...)`로 영속(현재 `onGateDecision` 미배선 `naby.ts:821` 배선). MCP 도구도 Executor라 자동으로 게이트 대상.

**(3) 승인 브리지 (난제)** — 비동기 게이트를 UI까지 왕복
- 런타임 `ApprovalController`: `pending: Map<toolCallId, resolve>`, `requestApproval(call)`가 이벤트 방출 + pending Promise 반환. 게이트가 이 Promise를 await → **해당 도구 호출에서 턴이 자연히 일시정지**.
- 스트림: 신규 `EngineEvent {kind:'approval_request', toolCallId, toolName, input}`를 **게이트 await 직전**에 방출(`engine.ts:170-226` 유니온에 추가). shell `onEvent` 스위치(`naby.ts:672`)에서 새 RunEvent로 번역 → 클라 프롬프트. 기존 `gate_result` 이벤트로 UI가 최종 allow/deny 재조정.
- 해소 엔드포인트: `POST /api/naby {action:'approval.resolve', toolCallId, decision, remember?}` (MCP action 유니온 `naby.ts:319-326` 옆에 추가) → pending resolve; `remember`면 `putPolicyRule`.
- UI: 승인 프롬프트(모달/칩) — Allow / Deny / "이 프로젝트에서 항상 허용". `mcp.approve`(`api/naby.ts:474-486`) + `NabyProviderSetup` 승인 버튼 **모양 재사용**. (단 MCP는 out-of-band, 여기선 **in-flight 턴 블로킹**이 차이.)
- 견고성: pending TTL(예 5분) → 만료 시 deny; 탭 종료/턴 stop(`session.ts:289` abort) 시 deny; 세션 resume 시 pending 재방출.

**(4) Settings — 권한 섹션**
- 기존 `AllowChangesToggle`(전역 on/off)를 **도구/스코프별 규칙 리스트**로 확장. SettingsModal 새 섹션 `permissions`(패턴 재사용). 규칙 조회/삭제/토글.

### P2 마일스톤
- **M1**: PolicyStore + realPolicy(규칙만, 승인 브리지 없이 안전 기본값) + Settings 규칙 리스트. 바닥을 규칙-기반으로 교체.
- **M2**: 승인 브리지(approval_request 이벤트 + resolve 엔드포인트 + UI 프롬프트 + remember). 인간 개입.

### P2 검증
- 스파이크 확장(`spike-03`/`03b` gate): allow-via-approval / deny / remember 3케이스. `makeGate` 로그로 "게이트가 실행 전에 봤다" 유지.
- 서브에이전트 내부 호출도 게이트 통과(기존 `spike-subagent-gate` 회귀).

---

## Phase 2.5 — 도구 보유 스킬 + 서브에이전트 오케스트레이션

### A. 도구 보유 스킬 실행

**toolRef 문법 정의**(신규, 문서화): `builtin:Read` | `mcp:<server>/<tool>` | `runtime:fetch_url`.

**resolveToolRefs(refs, available)** — `src/runtime/harness-tools.ts`(신규)
- refs를 현재 턴의 사용 가능 도구(builtin/mcp/runtime)에 매칭 → `{schemas, executors}` 서브셋.
- 미해석 ref → 스킬 **지시문은 주입하되** 누락 도구를 카운트/로그(무증상 반쪽 실행 금지 — 기존 원칙).

**주입 변경** — `skill-inject.ts`
- 배제 로직 완화: `selectSkillsForInjection`의 `excludedForTools` 필터(`skill-inject.ts:128-130`)를 뒤집어, 관련·enabled 도구 보유 스킬이면 (1) 지시문 주입 + (2) `resolveToolRefs` 결과를 턴 toolset에 union.
- toolset union 지점: shell `engines/naby.ts:475-481`(`toolSchemas=[...builtin,...mcp]`)에서 skill 기여 도구 합류. 합류 도구도 **전부 Phase 2 게이트** 통과.

### B. 서브에이전트 오케스트레이션 (엔진 이원화)

**dev-claude (Agent SDK)** — 네이티브 활용
- naby subagent(kind='subagent')를 SDK `query` options의 `agents` 정의로 매핑: `{systemPrompt, model?, allowedTools=resolveToolRefs}`. 매핑 지점 `claude-agent-sdk-engine.ts` QueryOptions 빌더(~line 127-166).
- SDK `Task` 툴이 스폰; **PreToolUse 게이트가 서브에이전트 내부까지 도달**(검증됨). 추가 게이트 작업 불필요.

**ai-sdk (metered/ChatGPT)** — 수동 위임
- 런타임 도구 `naby_delegate(name, task)` 신설: subagent의 systemPrompt + toolRefs-제한 toolset + model로 **중첩 세션** 실행, 최종 텍스트 반환.
- 깊이 제한(중첩 위임 N=1) + 전 호출 게이트. `runSubagent()` = `runTurn`의 얇은 래퍼.

**"/" 동작 승격**
- Phase 2.5 on이면 `/subagent`(또는 `@subagent`)가 실 위임 트리거. `framePersona`(`slashCommands.ts:313-317`) 폴백은 실행 불가 시 유지.
- `NabyHarnessReview`의 `needsPhase25` 배지 제거/활성.

### P2.5 마일스톤
- **M3**: toolRef 문법 + `resolveToolRefs` + 도구 보유 스킬 주입/도구 합류.
- **M4**: 서브에이전트 — dev-claude 네이티브 매핑, 그다음 ai-sdk `naby_delegate`.

### P2.5 검증
- `spike-skill-inject` 확장: 도구 보유 스킬이 지시문+도구 합류, 미해석 ref는 카운트.
- `spike-subagent-gate`/`spike-harness-visibility` 확장: naby subagent가 toolRefs 제한 하에 위임, 게이트가 내부 도달, deny 유지, 깊이 제한 준수.

---

## 순서 · 리스크 · 규모

**권장 순서**: M1 → M2 → M3 → M4 (각 독립 배포·검증 가능).
- M1/M2(Phase 2)를 먼저: 실행을 여는 스킬/서브에이전트가 반드시 실 게이트 뒤에 있어야 함.

**리스크**
- 승인 브리지의 mid-stream 블로킹(타임아웃/탭종료/resume) — pending TTL·disconnect-deny·재방출로 완화.
- ai-sdk 서브에이전트(수동 루프)가 dev-claude(네이티브)보다 작업량 큼.
- toolRef 문법은 하네스 세트 이식성에 영향 → 초기에 확정·문서화.

**대략 규모(감)**: M1 소, M2 중(브리지+UI), M3 중, M4 중~대(엔진 이원화). 스파이크 우선(TDD) 권장.

**미결정(착수 전 확정 필요)**
- 승인 UI 위치: 채팅 인라인 vs 전역 모달.
- 기본 정책 강도: 새 프로젝트에서 변형/실행을 기본 ask vs 기본 deny.
- toolRef 문법 최종형.
