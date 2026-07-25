---
id: phase-3-checkin-contracts
title: Phase 3 P3-M5 — 체크인 원장 계약 (eval_events 실체화)
type: interface
version: 0.3.0
status: active
scope: 나비 신뢰 지표가 읽고 쓰는 이벤트 원장의 계약. P15-03이 예약해 둔 `eval_events` 스키마를 체크인·자율행동·트립와이어 세 종류 이벤트로 실체화하고, 스토어 메서드와 불변식을 정의한다. 지표 계산 알고리즘 자체는 butterfly-trust-meter가 다룬다.
related: [phase-3-butterfly-trust-meter, phase-3-persona-agent, phase-1_5-personalization-data-layer, phase-1_5-memory-contracts, phase-2-personalization-hitl]
updated: 2026-07-26
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
  /** What was asked, verbatim. The panel shows it, and the degenerate check
   *  compares a new question against recent ones to catch the same ask twice. */
  question?: string;
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
6. **아무도 답하지 않은 체크인은 행이 되지 않는다.** 턴이 중단되거나 프롬프트가 만료된 것은 관측이 아니다. 빗나감으로 적으면 사용자가 자리를 비운 것을 에이전트 탓으로 돌리고, 제외 행으로 적어도 커버리지를 같은 이유로 끌어내린다. "모두 남긴다"가 틀리는 유일한 경우다 — 남기는 사건 자체가 지어낸 것이기 때문이다.
7. **`autonomous`와 `tripwire`는 에이전트가 아니라 게이트가 쓴다.** 결과적 행동(`isConsequentialTool`)이 통과하면 `autonomous`, 거부되면 `tripwire`다. 에이전트는 묻지 않기를 고를 수 있어도 **집계되지 않기를 고를 수는 없다**(지표 §4.5).

## 5. API

`POST /api/naby`에 액션을 더한다.

| 액션 | 용도 |
|---|---|
| `growth.get` | `{agentId?}` — 생략하면 내장 페르소나. 단계·퍼센티지·적중률·커버리지·후퇴 사유 코드·작업 유형별 분해·최근 결정 목록을 낸다. 설정 패널이 읽는다 |
| `checkin.resolve` | `{checkinId, chosen, correction?}` — 멈춘 체크인을 확정한다. `chosen: -1`은 자유 서술이며 `correction`이 **필수**다. M2 `approval.resolve`와 같은 모양 |

`growth.get`은 **작업 유형별 분해**를 함께 낸다. 멘션 게이트는 전역 단계를 쓰고 패널이 분해를 보여준다.

`@` 팔레트는 `growth.get`이 아니라 `/api/commands`가 같은 읽기 함수(`growthRead`)를 호출해 배지를 붙인다. **두 표면이 한 함수를 공유하는 것이 계약이다** — 팔레트가 "나비"라 하고 패널이 "번데기"라 하면 지표의 신뢰가 숫자가 틀린 것보다 빨리 무너진다.

## 6. 미결정

- `taskType`을 누가 정하는가. 모델이 붙이면 게이밍 표면이 늘고, 도구 조합에서 유도하면 거칠다. 1차는 **모델이 제시하되 원장에 그대로 기록하고**, 유형별 질문율 상한으로 남용을 잡는다.
- `domain` 태그는 P15-03이 예약했으나 M5에서 쓰지 않는다. 필드만 두고 비워 둔다(나중에 마이그레이션이 필요 없게).
- **커버리지는 호출 단위로 센다.** 체크인 한 번 뒤에 쓰기 세 번이면 `autonomous` 세 행이다. 지금은 커버리지를 **보고만 하고 게이트로 쓰지 않으므로** 성립하지만, 커버리지 하한을 실제로 걸려면 "체크인이 자기 결정을 수행하는 호출들을 어떻게 자기 것으로 주장하는가"를 먼저 정해야 한다.
- **MCP 도구는 분류되지 않는다.** `isConsequentialTool`은 하네스 내장 도구와 우리 도구만 안다. 메일을 보내는 서드파티 MCP 도구는 실제로 결과적이지만 행을 남기지 않는다. 도구 이름으로 위험을 추측하는 것이 더 나쁘다 — 선언된 주석이나 사용자 정책 규칙 같은 실제 신호가 필요하다.
- ✅ **체크인 텔레그램 에스컬레이션 완료(2026-07-26).** 한 폴링 루프가 두 종류의 질문을 처리한다 — 승인은 허용/거부, 체크인은 번호 버튼(`nbchk:<index>:<ref>`)이다. 루프를 둘 돌리면 `getUpdates`가 둘 떠서 텔레그램이 409로 답하고 양쪽이 다 깨지므로, 워터마크와 백로그 드레인을 공유한다.
  - **여기서 잠재 버그를 잡았다.** `callback_data`는 64바이트가 한계인데, 승인 콜백이 id를 그대로 박고 있었다. 실측하니 Agent SDK의 UUID 세션이면 **78바이트**로 넘쳐서 sendMessage 자체가 실패한다 — 버튼이 아예 안 뜨고 에스컬레이션이 조용히 "앱에서 답하세요"로 퇴화한다. 이제 짧은 **ref 토큰**을 쓰며, 승인·체크인 모두 구조적으로 한계 안에 들어온다.
  - **추천안은 전화기로 보내지 않는다.** 인앱 프롬프트가 답한 뒤에 공개하는 이유(지표가 UI 순응도를 재게 된다)가 전화기에서 더 강하게 적용된다. 사용자가 가장 덜 숙고하는 화면이다.
  - **숫자 답장은 범위 안에서만 인정한다.** "첫 번째 것" 같은 말은 추측하지 않는다 — 체크인이 존재하는 이유가 에이전트가 추측할 수 없었기 때문이고, 여기서 잘못 추측하면 **사용자 본인의 답으로 기록된다.**
