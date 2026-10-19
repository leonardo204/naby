---
id: cross-session-messaging
type: design
version: 0.2.0
status: implemented
scope: 한 프로젝트에 열린 세션 탭 사이에 나비가 요청을 보내고 답을 받는 기능. 보내는 도구와 목록 도구, 받는 세션의 턴 실행과 대기, 답을 보낸 세션에 새 턴으로 돌려주는 경로, 두 탭의 표시, 반복 방지, 활동 로그를 다룬다. 참가자 위임(multi-agent-chat)과 서브에이전트 위임(subagent-delegation)은 다루지 않는다.
related: [multi-agent-chat, subagent-delegation, session-context-management, telegram-chat, naby-activity-log]
updated: 2026-10-19
---

# 세션 간 요청 주고받기

> 이 문서가 답하는 질문 — **"1번 탭에서 일하다가 2번 탭에 검색을 맡기고, 그 답을 1번 탭에서 받아 이어가려면 무엇을 만들어야 하나?"**
>
> 사용자 요구(2026-10-19): Claude Code의 세션 간 메시지 주고받기를 나비 탭에서도 제공한다. 1번 세션에 "2번 세션에 보내서 검색하고 결과를 받아 달라"고 하면, 2번 탭이 컨텍스트를 받아 일하고(과정은 2번 탭에서 보인다) 결과를 1번 세션에 돌려준다. 같은 날 설계안을 보고했고, 사용자는 이어서 다른 요청을 덧붙이며 진행시켰다.

## 1. 이미 있는 것

- **턴 진입점 하나.** 모든 턴은 `dispatchChat`(`engines/orchestrator.ts`)을 지난다. 텔레그램·예약 작업·작업 보고도 여기로 들어온다.
- **세션별 실행 잠금.** 실행 중인 세션에 새 턴을 넣으면 409가 난다. 큐는 없고, 호출하는 쪽이 다시 시도한다(`lib/backgroundJobReport.ts`의 제한 재시도).
- **탭 실시간 표시.** 탭마다 `/ws/session-stream`으로 자기 세션을 따라간다(`sessionRunHub.ts`). 서버가 세션 B에 시작한 턴은 B 탭에 그대로 보인다.
- **두 가지 기존 틀.** 텔레그램은 턴을 시작하고 끝날 때까지 기다린 뒤 답을 꺼낸다(`lib/telegramChat.ts`, `extractRunAnswer`). 작업 보고는 일이 끝나면 소유 세션에 새 턴을 넣는다(`makeJobSink`).
- **열린 탭 = 프로젝트 세션.** 프로젝트의 열린 탭은 `store.listSessionsByProject(cwd)`와 같다. 탭을 닫으면 세션이 지워진다.

## 2. 요구사항

- **R1 목록.** 나비는 같은 프로젝트에 열린 다른 세션을 볼 수 있다. 세션 id, 제목, 마지막 사용자 메시지 앞부분, 실행 중 여부를 본다. 자기 세션은 빠진다.
- **R2 보내기.** 나비는 대상 세션에 요청과 넘길 컨텍스트를 보낸다. 도구는 곧바로 돌아오고 보낸 세션의 턴은 잠기지 않는다.
- **R3 받는 쪽 턴.** 대상 세션에 새 턴이 시작되고 그 탭에서 과정이 보인다. 대상이 실행 중이면 끝날 때까지 기다렸다 시작한다.
- **R4 답 돌려주기.** 받는 쪽 턴이 끝나면 그 답이 보낸 세션에 새 턴으로 들어간다. 보낸 쪽 나비는 답을 보고 원래 작업을 잇는다. 사용자가 답을 요구하지 않은 보내기(`expectReply: false`)는 돌려주지 않는다.
- **R5 표시.** 받는 탭에는 "세션 ‹제목›에서 온 요청" 표시가, 보낸 탭에는 "세션 ‹제목›의 답" 표시가 붙는다. 둘 다 펼치면 원문을 본다.
- **R6 범위.** 대상은 같은 프로젝트(cwd)의 세션뿐이다. 다른 프로젝트 세션 id를 주면 거절한다.
- **R7 반복 방지.** 다른 세션의 요청으로 시작된 턴과 답을 돌려받아 시작된 턴에는 보내기 도구를 주지 않는다. A→B→A로 도는 길이 없다.
- **R8 실패.** 대상이 30초 안에 비지 않으면 제한 재시도를 이어가고, 시작조차 못 하면 보낸 세션에 "전달 실패"를 넣는다. 받는 쪽 턴이 오류로 끝나거나 30분 안에 끝나지 않으면 "응답 실패/시간 초과"를 넣는다. 대상 탭이 닫히면 "대상 세션이 닫힘"을, 보낸 탭이 닫혔으면 답을 버린다.
- **R9 기록.** 보내기·받기·돌려주기·실패를 활동 로그(`cross_session_message`)에 남긴다.
- **R10 끄기.** 설정 `sessions.crossSession.enabled`(기본 켬)가 꺼지면 두 도구를 주지 않는다.

## 3. 설계

### 3.1 도구

| 이름 | 입력 | 결과 |
|---|---|---|
| `naby_list_sessions` | 없음 | 같은 프로젝트의 다른 세션 목록(R1) |
| `naby_send_to_session` | `sessionId`, `request`(필수), `context`(선택, 넘길 배경), `expectReply`(기본 true) | 곧바로 `{ ok, requestId }`. 실패 사유가 확실하면(범위 밖·없는 세션·자기 자신) 오류 |

- 나비가 자기 턴일 때만 준다. 참가자 턴·위임 턴·R7 턴에는 빠진다.
- 둘 다 게이트를 지난다. 목록은 읽기, 보내기는 결과가 남는 호출로 분류한다. 정책 규칙으로 막을 수 있다.
- 도구 설명에 "사용자가 다른 세션에 맡기라고 했을 때만 쓴다"를 넣는다.

### 3.2 전달 경로 (셸 `lib/crossSession.ts`)

1. `send` 호출 → 요청 id를 만들고 메모리 대기열(`globalThis` 고정)에 올린 뒤 즉시 반환한다. 활동 로그 `sent`.
2. 배달 루프가 `dispatchChat(nabySpec, { sessionId: B, prompt, source: 'cross-session', crossSession: { requestId, fromSessionId: A, fromTitle, role: 'request' } })`를 부른다. 409면 작업 보고와 같은 제한 재시도를 한다.
3. 받는 쪽 프롬프트는 구조화된 머리말과 펜스로 감싼다. 넘어온 요청·컨텍스트는 다른 세션의 모델이 쓴 글이므로 `untrusted_` 펜스 규칙(participants의 `defuseUntrusted`)을 그대로 쓴다.
4. 텔레그램처럼 `addRunListener`·`isRunActive`로 B 턴 끝을 기다리고 `extractRunAnswer`로 답을 꺼낸다(30분 한도).
5. `expectReply`면 A에 `dispatchChat({ sessionId: A, prompt: 답, crossSession: { requestId, fromSessionId: B, fromTitle, role: 'reply' } })`를 같은 재시도로 넣는다. 답이 너무 길면 앞부분(12k자)만 넣고 잘렸다고 적는다.
6. 실패도 `role: 'failure'`로 A에 새 턴을 넣는다(R8). 나비가 사용자에게 실패를 알리고 다시 할지 묻게 하려는 것이다. `expectReply:false`였으면 실패도 돌려주지 않고 활동 로그에만 남긴다.

대기열은 메모리에만 둔다. 앱이 재시작되면 진행 중이던 요청은 사라지고, 다음 부팅에 따로 알리지 않는다(1차 제약).

### 3.3 저장과 표시

- 사용자 행에 `crossSession?: { requestId, fromSessionId, fromTitle, role: 'request'|'reply'|'failure' }`를 담는다. 메시지 payload JSON이라 이전 없이 들어간다(텍스트 접두어로 판별하지 않는다).
- `toChatMessages`가 이 행을 `role:'system'`, `systemEvent.kind: 'cross-session'`으로 바꾼다. 클라이언트는 작업 보고 알림과 같은 흐린 알약에 방향 아이콘과 제목을 넣고, 누르면 원문 모달을 연다.
- 모델 이력에는 머리말이 붙은 원문 그대로 남는다.

### 3.4 반복 방지와 한도

- 턴 입력의 `crossSession`이 있으면(R7) 보내기 도구를 뺀다.
- 한 세션이 동시에 보낼 수 있는 미완료 요청은 3개다. 넘으면 도구가 오류를 낸다.

## 4. 검증

- 런타임: 프롬프트 머리말·펜스 조립, 답 자르기 같은 순수 함수는 스파이크 또는 단위 테스트로 본다.
- 셸 vitest(mock 엔진, 실제 모델 호출 없음): 보내기→B 턴→A 답 턴 왕복, 409 재시도, 범위 밖 거절, 자기 자신 거절, R7 턴에 도구 없음, 시간 초과, 대상 닫힘, 보낸 쪽 닫힘, `expectReply:false`, 동시 한도, `toChatMessages` 매핑, 설정 끄기.
- 실제 앱: prod 빌드에서 탭 두 개로 시나리오 한 번(사용자 확인 항목).

## 5. 구현 상태

2026-10-19에 1차 구현을 마쳤다. 실제 앱 확인(§4 마지막 줄)은 남아 있다.

**런타임**

- `src/runtime/cross-session.ts` — 도구 이름·스키마, 입력 파서, 요청·답·실패 프롬프트 세 개, 펜스 처리와 답 자르기(12k자)를 둔 순수 모듈이다. `runtime-entry.ts`로 내보낸다.
- `RuntimeMessage`에 `crossSession`을, `runTurn` 옵션에 `crossSession`을 더했다. 있으면 사용자 행에 그대로 저장한다.
- `isUserAuthored`가 `crossSession` 행을 사용자 글로 보지 않는다. sqlite의 참가자 추천 집계도 같은 조건으로 맞췄다.
- 체크인 분류에서 `naby_list_sessions`는 관찰, `naby_send_to_session`은 결과가 남는 호출로 둔다. 활동 로그 종류 `cross_session_message`를 더했고, `phase`(sent·delivered·answered·replied·dropped·failed)로 구분한다.
- 스파이크 `npm run spike:cross-session` 35개 검사가 통과한다(`spike:all`·`spike:nokeys`에 포함).

**셸**

- `lib/crossSession.ts` — 대기열(`globalThis`), 배달(`deliverCrossSession`), 두 도구(`makeCrossSessionTools`), 설정 읽기·쓰기를 둔다. 양쪽 다리 모두 `dispatchChat(nabySpec, { source: 'cross-session', crossSession })`를 지나고, 409는 작업 보고와 같은 제한 재시도(30초 간격 5회)를 쓴다. B 턴 대기는 텔레그램처럼 `isRunActive` 폴링과 `extractRunAnswer`로 한다.
- `engines/naby.ts` — 나비가 자기 턴이고(채팅·텔레그램), 프로젝트가 있고, 다른 세션이 시작한 턴이 아니고, 설정이 켜져 있을 때만 두 도구를 준다. 위임 실행의 도구 목록에서 빼고, 서브에이전트 호출은 게이트에서 거절한다. 첫 단계 `runTurn`에 `crossSession`을 넘긴다. 테스트용 주입점 `crossSessionDelivery`를 더했다.
- `participantTurn.ts` — 참가자 제외 목록에 두 도구를 더했다.
- 실시간 표시 — `DispatchParams.crossSession`을 오케스트레이터가 `startRun`의 `_human` 이벤트에 `_crossSession`으로 싣는다. `useLiveStream`은 이 이벤트를 사용자 말풍선 대신 알림 알약으로 그린다.
- 이력 표시 — `toChatMessages`가 `crossSession` 행을 `systemEvent.kind: 'cross-session'`(`status`=방향, `peer`=상대 세션 제목)으로 바꾼다. `MessageBubble`은 방향 아이콘(📥 요청·📤 답·⚠️ 실패)과 제목을 알약에 넣고, 모달에 원문을 보인다. 문구는 en·ko에 `chat.crossSession.*`로 넣었다.
- 설정 — `/api/naby`에 `crossSession.get`·`crossSession.set`을 더했다. 설정 화면의 참가자 섹션 아래에 `CrossSessionToggle`을 붙였다(`agentManager.crossSession.*`).
- 셸 테스트 — `lib/crossSession.test.ts` 19개, `engines/nabyCrossSession.test.ts` 5개가 통과한다. 위임 필터 문자열을 확인하던 `nabyParticipantDraft.test.ts`의 단언을 새 필터에 맞췄다.

**설계에서 달라진 점**

- `defuseUntrusted`를 그대로 쓰지 않고 같은 태그 무력화 규칙만 따르는 `defuseFenced`를 새로 두었다. `defuseUntrusted`는 공백을 접어 한 줄로 만드는데, 검색 지시나 답은 줄바꿈이 있어야 읽기 쉽다.
- R7 턴에서는 보내기 도구뿐 아니라 목록 도구도 뺀다. 보낼 수 없는 턴에 목록만 남길 이유가 없다.
- 예약 작업·작업 보고 턴에는 두 도구를 주지 않는다. 사용자가 맡기라고 말할 자리가 없는 턴이기 때문이다.
- 답·실패를 A에 넣을 때는 5회 제한 재시도를 쓰지 않는다. A가 긴 턴을 도는 것은 정상이므로, A가 쉴 때까지 기다렸다 넣는다(최대 30분, 기다리는 동안 예약을 갱신하고, 넣는 순간의 409는 계속 기다림으로 본다). 30분을 넘기면 답을 버리고 활동 로그에 `dropped`(`sender-busy`)로 남긴다. 기다리는 중에 A 탭이 닫히면 바로 멈추고 `sender-closed`로 남긴다. B 쪽 전달은 R8대로 제한 재시도를 유지한다.

**남은 일**

- prod 빌드에서 탭 두 개로 왕복을 확인한다(특히 B 탭의 실시간 알약과 A 탭의 답 턴).
- 앱을 재시작하면 진행 중이던 요청은 알림 없이 사라진다(§3.2의 1차 제약).

## 변경 이력

- 0.1.0 (2026-10-19) — 첫 설계.
- 0.2.0 (2026-10-19) — 1차 구현. §5 구현 상태를 채웠다.
