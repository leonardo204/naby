---
id: phase-3-checkin-contracts
title: Phase 3 P3-M5 — 체크인 원장 계약 (eval_events 실체화)
type: interface
version: 0.1.0
status: review
scope: 나비 신뢰 지표가 읽고 쓰는 이벤트 원장의 계약. P15-03이 예약해 둔 `eval_events` 스키마를 체크인·자율행동·트립와이어 세 종류 이벤트로 실체화하고, 스토어 메서드와 불변식을 정의한다. 지표 계산 알고리즘 자체는 butterfly-trust-meter가 다룬다.
related: [phase-3-butterfly-trust-meter, phase-3-persona-agent, phase-1_5-personalization-data-layer, phase-1_5-memory-contracts, phase-2-personalization-hitl]
updated: 2026-07-25
---

# 체크인 원장 계약 — `eval_events` 실체화

## 1. 왜 새 테이블을 만들지 않는가

`phase-1_5-personalization-data-layer`가 **P15-03(eval-event 스키마)** 를 이미 예약해 두었고 상태가 "Phase 2a의 F2-04 로거가 쓰기 시작할 때 함께 착수"로 보류였다. 담기로 한 것은 **task_type, domain, edit diff**다.

그리고 `phase-1_5-memory-contracts`가 세 곳에서 그 이름에 의존한다.

- `MemoryProvenance.createdFrom` — "eval_event id or message id it was extracted from"
- `MemoryInjectionQuery.taskType` — "aligns with eval_events.task_type"
- `GoldenItem.taskType` — "aligns with eval_events.task_type / P15-03"

체크인 원장은 **바로 그 스트림이다.** 따로 만들면 같은 목적의 이벤트 테이블이 둘 생기고 `createdFrom`이 어느 쪽을 가리키는지 모호해진다. 그래서 P3-M5는 새 계열을 만들지 않고 **P15-03을 구현한다.** 판별자(`kind`)를 두어 앞으로 F2-04가 쓸 초안·최종본·편집 diff 이벤트도 같은 테이블에 들어오게 한다.

## 2. 레코드

```ts
/** What kind of observation this row is. One stream, discriminated — so a later
 *  F2-04 draft/final/edit-diff event lands here too, not in a second table. */
type EvalEventKind =
  | 'checkin'      // the agent asked before an irreversible step
  | 'autonomous'   // the agent acted without asking
  | 'tripwire';    // a safety-relevant call was refused by the gate

type EvalEvent = {
  id: string;                 // UUID — what MemoryProvenance.createdFrom points at
  kind: EvalEventKind;
  at: number;                 // epoch ms — ordering, window cuts, drift detection
  agentId: string;            // growth is per agent
  sessionId: string;          // where it happened (rollback / audit)
  taskType?: string;          // P15-03's task_type — the per-scope trust axis
  domain?: string;            // P15-03's domain tag (reserved; unused in M5)

  // -- kind: 'checkin' -----------------------------------------------------
  /** The options the agent offered, in the order shown. */
  options?: string[];
  /** Index into `options` the agent RECOMMENDED. Its prediction. */
  recommended?: number;
  /** Index the user actually chose, or -1 when they answered freely. */
  chosen?: number;
  /** true iff the user took the recommendation unchanged. The label. */
  hit?: boolean;
  /** The agent's own stated confidence in its recommendation, 0–1. Recorded but
   *  NOT trusted: the Brier axis measures whether it is calibrated. */
  confidence?: number;
  /** Free-text correction when `chosen` is -1 — the edit-diff analogue. */
  correction?: string;

  // -- kind: 'autonomous' --------------------------------------------------
  /** Whether the action could be undone (snapshot / reversible tool). */
  reversible?: boolean;
  /** Set true when the user later corrected the result — the miss signal for
   *  the covered region, without which coverage would be free to inflate. */
  correctedAfter?: boolean;

  // -- kind: 'tripwire' ----------------------------------------------------
  toolName?: string;
  reason?: string;

  /** Excluded from scoring because it looks degenerate (near-duplicate question,
   *  a single real option). Kept, never silently dropped — §7 anti-gaming. */
  excludedFromScoring?: boolean;
};
```

## 3. 스토어 메서드

```ts
appendEvalEvent(event: EvalEventInput): EvalEvent;   // id/at are store-owned when omitted
listEvalEvents(agentId: string, opts?: {
  kind?: EvalEventKind;
  taskType?: string;
  /** Newest N — the growth window reads this rather than the whole history. */
  limit?: number;
}): EvalEvent[];
deleteEvalEvents(selector: { agentId: string } | { sessionId: string }): void;
```

`deleteEvalEvents`는 사용자가 세션이나 에이전트를 지울 때 원장도 함께 지우기 위한 것이다. **성장 기록은 사용자의 행동 기록이므로 지울 수 있어야 한다** — 메모리의 delete-by-source와 같은 원칙이다.

## 4. 불변식

1. **`hit`은 파생값이 아니라 저장값이다.** `recommended === chosen`으로 매번 계산하면 선택지 순서가 바뀐 과거 행의 의미가 흔들린다. 기록 시점에 확정해 저장한다.
2. **`checkin`은 `options.length >= 2`이고 `recommended`가 그 범위 안이어야 한다.** 선택지가 하나면 물음이 아니다(§7 퇴화 체크인).
3. **`tripwire`는 점수에 섞이지 않는다.** 적중률 계산에서 제외되고, 창 안에 하나라도 있으면 나비 판정을 막는 하드 게이트로만 쓰인다.
4. **세션 삭제가 성장 기록을 연쇄 삭제하지 않는다.** 원장은 `agentId`로 키잉되고 `sessionId`는 링크다 — 메모리의 키잉 불변식(`phase-1-contracts` §6)과 같은 이유다. 대화를 지웠다고 배운 것이 사라지면 안 된다.
5. **에이전트는 이 테이블을 읽을 수 없다.** 도구로도, 주입으로도 노출하지 않는다. 자기 점수를 보면 그것을 최적화한다(§7).

## 5. API

`POST /api/naby`에 액션을 더한다.

| 액션 | 용도 |
|---|---|
| `growth.get` | 에이전트의 현재 단계·퍼센티지·적중률·커버리지·후퇴 사유 코드. 설정 패널과 `@` 팔레트가 읽는다 |
| `checkin.resolve` | 인라인 프롬프트에서 사용자가 고른 선택지를 확정한다. M2 승인 브리지의 `approval.resolve`와 같은 모양 |

`growth.get`은 **작업 유형별 분해**를 함께 낸다. 멘션 게이트는 전역 단계를 쓰고 패널이 분해를 보여준다.

## 6. 미결정

- `taskType`을 누가 정하는가. 모델이 붙이면 게이밍 표면이 늘고, 도구 조합에서 유도하면 거칠다. 1차는 **모델이 제시하되 원장에 그대로 기록하고**, 유형별 질문율 상한으로 남용을 잡는다.
- `domain` 태그는 P15-03이 예약했으나 M5에서 쓰지 않는다. 필드만 두고 비워 둔다(나중에 마이그레이션이 필요 없게).
