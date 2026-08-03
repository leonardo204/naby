---
id: phase-3-persona-agent
title: Phase 3 — Personal Persona Agent (naby 자체 에이전트 레이어)
type: design
version: 0.12.0
status: review
scope: naby 자체의 에이전트 레이어 — 페르소나 에이전트 데이터 모델, @ 라우팅, Settings 재편, 마일스톤 M1~M6(모델·라우팅·자율/에스컬레이션·학습·신뢰지표·내보내기). 신뢰 지표 알고리즘은 butterfly-trust-meter, 원장 계약은 checkin-contracts, 내보내기는 agent-export로 내려간다.
related: [phase-3-butterfly-trust-meter, phase-3-checkin-contracts, phase-3-agent-export, phase-3-continuous-learning, phase-3-persona-hardening, phase-3-memory-hygiene, phase-2-2.5-plan, personalization-strategy, harness-portability-strategy, phase-1_5-memory-contracts]
updated: 2026-08-03
---

# Phase 3 — Personal Persona Agent (naby 자체 에이전트 레이어)

> 상태: 설계 초안(2026-07-25). 프로젝트의 최종 목표를 구조로 옮기는 전환점이다.
> 한 줄 요약: naby를 "하네스(도구)를 지원하는 환경"에서 "사용자를 대리하는 **페르소나 에이전트**를 내장한 제품"으로 바꾼다.

## 1. 목표 (사용자 정의)

- naby **자체**의 에이전트 레이어를 새로 만든다. **페르소나 에이전트**는 기본으로 들어 있고, 사용자는 필요할 때 에이전트를 하나씩 추가한다.
- 페르소나 에이전트는 사용자의 판단과 행동을 **학습**한다. 지시를 받으면 사용자를 **대리해 일을 처리하고**, 꼭 사람이 판단해야 하는 상황만 넘긴다(에스컬레이션). 일하는 중에는 텔레그램으로 알리고, 끝나면 결과를 보고한다.
- 예: `@페르소나 이 테스트 90% 도달까지 처리하고, 크리티컬 아니면 알아서 해. 꼭 판단 필요하면 텔레그램으로 알리고 마무리 후 보고.`

## 2. 두 레이어 (재정의)

| 레이어 | 소유 | 구성 | 호출 |
|---|---|---|---|
| **naby 에이전트 레이어**(신설) | naby 자체 | 내장 **페르소나 에이전트**와 사용자가 추가한 에이전트. **메모리가 여기로 옮겨온다**(에이전트가 학습한 기억) | **`@`** — 파일을 참조할 때처럼 `@에이전트명 <지시>`로 그 에이전트에게 맡긴다 |
| **하네스 레이어**(기존) | 사용자 naby-layer | **command / skill / subagent**(스킬을 하네스 하위 갈래로 둔다) | **`/`** — 하네스의 스킬·서브에이전트·커맨드를 부른다 |

정리하면 `/`는 도구(하네스)를, `@`는 에이전트를 부른다(`@`는 파일 참조도 겸한다). 메모리는 에이전트에 속하고 스킬은 하네스에 속한다.

## 3. 기존 자산 매핑 (부품은 대부분 이미 있다)

- **에이전트 실행** — M4 서브에이전트 오케스트레이션(`runTurn` + systemPrompt + toolRefs)을 그대로 쓴다. 페르소나 에이전트는 **naby가 소유하는 1급 에이전트**다. 사용자 하네스 subagent와는 별개이며 처음부터 시드로 들어간다.
- **학습과 기억** — 메모리 시스템(store `memory_items`, 쓰기 게이트 `decideMemoryWrite`, 주입 `retrieveMemories`)을 쓴다. ⚠️ 주입이 셸에 아직 연결되지 않았다(스킬과 같은 dormant 상태). 페르소나 턴에 주입을 연결해야 한다.
- **에스컬레이션** — **M2 승인 브리지를 재사용한다.** 인라인 프롬프트 대신, 또는 인라인과 함께, **텔레그램으로 앱 밖에** 질문을 보내고 답신으로 승인을 해소한다. `approvalRegistry`는 이미 앱 밖 해소를 지원한다.
- **자율 실행(90%까지 알아서)** — 목표를 좇는 루프(ralph나 `/loop`처럼 끝날 때까지 이어가는 방식)에 기존 **scheduled tasks** 인프라를 쓴다.
- **알림과 보고** — 텔레그램으로 보낸다. 지금 dotclaude-messenger는 외부 커맨드여서 naby 런타임에는 텔레그램이 없으므로 통합해야 한다. 여기에 최종 리포트 메시지를 더한다.
- **정책 게이트** — M1/M2를 그대로 물려받는다. 에이전트의 툴콜도 게이트를 통과한다.

## 4. 데이터 모델 (신설)

`agents` 스토어 슬라이스(하네스와 별개):
```
Agent {
  id, name, kind: 'persona' | 'custom',
  systemPrompt,            // 페르소나 지시 (학습 컨텍스트는 주입으로 합성)
  model?,
  toolRefs?,               // 허용 도구
  memoryScope,             // 이 에이전트가 읽고 쓰는 메모리 스코프
  autonomy: { maxSteps?, escalation: 'inline'|'telegram'|'both' },
  createdAt, updatedAt
}
```
- 최초 실행 때 **built-in 페르소나 에이전트 하나를 시드로 넣는다**. **삭제도 편집도 할 수 없다**(2026-07-30 사용자 결정, §8 참조). 시드가 기본값을 강제한다 — 부팅할 때마다 저장된 행을 `BUILTIN_PERSONA_SEED`와 비교해 한 필드라도 어긋나면 시드 값으로 되돌린다. `id`와 `createdAt`만 남기므로 원장·기억·성장 이력은 그대로 붙어 있다.
  - 강제는 스토어에서 한다. `putAgent`는 kind='persona' 행에 쓰려는 모든 시도를 **throw로 거절**하고, 시드만 쓰는 `restoreBuiltinPersona`가 유일한 통로다. 셸 라우트(`agent.put`)도 같은 거절을 사람이 읽을 문장으로 먼저 답한다.
  - 페르소나 카드는 읽기 전용이다. Edit·Remove 버튼이 없고, 배지·설명·성장 패널·내보내기만 남는다.
  - ⚠️ **2026-08-03 개정(§8.2)**: 시드의 `name`은 `naby`다. `name`이 시드 소유 필드이므로 **기존 설치의 `persona` 행은 다음 부팅의 heal이 `@naby`로 고쳐 쓴다**(id·createdAt 유지, 마이그레이션 없음). `kind='persona'`와 `BUILTIN_PERSONA_ID`는 바뀌지 않는다.

## 5. 호출 라우팅 (`@`)

- `ChatInput`과 디스패치에서 줄이 `@<agentName> ...`으로 시작하면 그 에이전트로 턴을 라우팅한다.
  - ⚠️ 지금 `@`는 두 가지로 쓰인다. 하나는 서브에이전트 커맨드(`@verb`), 하나는 파일 절대경로 삽입이다. **충돌을 정리해야 한다.** 우선순위는 `@에이전트명`(등록된 agent) > `@하네스subagent` > 파일이며, 등록된 에이전트 이름을 먼저 맞춰 본다.
- 라우팅한 턴은 에이전트의 systemPrompt, 주입된 메모리, 에이전트 toolRefs, autonomy 모드로 구성된다. `resolveCommandPrompt`와 `runTurn`을 확장한다.

## 6. Settings 재편

- **"에이전트"** 섹션을 새로 만든다. 내장 페르소나를 보여주고 추가·편집을 지원하며, **메모리(NabyMemoryReview)를 이 아래로 옮긴다**.
  - ⚠️ **2026-08-03 개정(§8.2)**: 섹션 이름은 **'나비'/'Naby'**이고, **추가(생성) UI는 없다**. 편집은 가져온 커스텀 에이전트에만 남는다.
- **하네스** 섹션에 **커맨드·스킬·서브에이전트 서브탭을 합친다.** 지금 따로 있는 "커맨드" 섹션을 흡수한다. 스킬은 이미 하네스에 속한다.
- 정리된 nav: theme · language · provider · **Agents(페르소나+메모리)** · **Harness(command/skill/subagent)** · Permissions · about.

## 7. 마일스톤 (Phase 3)

- **P3-M1** ✅ **구현 완료(2026-07-25, 커밋 대기)** — 데이터 모델(`agents` 스토어), built-in 페르소나 시드, Settings "에이전트" 섹션, 메모리 이동, 커맨드를 하네스로 흡수. 구조만 재편하고 실행은 없다.
  - 런타임: `store.ts`에 Agent/AgentInput/AgentKind/AgentEscalation/AgentAutonomy와 `listAgents/getAgent/getAgentByName/putAgent/removeAgent`를 두 드라이버 모두에 넣었다. `agents.ts`(BUILTIN_PERSONA_ID/SEED/seedBuiltinPersona)에서 페르소나 삭제 금지를 store가 강제한다. **(2026-07-30 개정: 편집 금지도 store가 강제하고, 시드가 기본값을 되돌린다 — §4·§8.1.)** runtime-entry로 내보내고, `spike-agents`가 30체크 × 2드라이버와 재오픈 시 중복 없음을 PASS로 확인했다.
  - 셸: `getStore()` 합성 루트에 `seedBuiltinPersona`를 멱등으로 연결했다. `api/naby.ts`에 `agent.list/put/remove` 액션, `NabyAgentManager.tsx`(신규), Settings `agents` 섹션(메모리 이동)과 `harness` 섹션(커맨드 흡수), i18n `agentManager.*`(en/ko)를 추가했다.
  - 검증: 타입체크 clean(두 트리, 베이스라인 노이즈만), `build:app` exit 0. 실서버를 띄우고 `/api/naby`로 agent.list 시드 확인, put, 페르소나 삭제 거부, 중복 이름 거부를 모두 통과했다. **미검증: Settings UI가 실제로 어떻게 보이는지(라이브 창이 필요하다).**
  - 결정: 페르소나는 kind='persona' 하나뿐이고 사용자는 custom만 만든다. name은 `@` 라우팅 핸들이라 UNIQUE이고 공백을 쓸 수 없다. memoryScope는 학습 스코프이며 주입 연결은 P3-M2에서 한다. escalation은 inline으로 두고 텔레그램은 P3-M3에서 붙인다.
- **P3-M2** ✅ **구현 완료(2026-07-25, 커밋 대기)** — `@에이전트` 라우팅. 지정한 에이전트로 턴을 실행하고(systemPrompt + 메모리 주입 + toolRefs), 메모리 자동 주입을 연결했다. M3와 M4가 이 배선을 재사용한다.
  - 런타임: `agents.ts`에 `parseAgentAddress(prompt)`를 넣었다. `@name`과 task를 분리하는 순수 파서이며 runtime-entry로 내보낸다. `spike-agents`에 파서 7체크를 더했다.
  - 셸 `naby.ts`: `parseAgentAddress` 결과를 `getAgentByName`으로 찾아 라우팅한다. 라우팅하면 (a) userText는 주소를 뗀 task, (b) system은 agent.systemPrompt + cwd 노트, (c) model은 agent.model을 먼저 쓰고, (d) **toolRefs allowlist를 게이트 가장 바깥의 deny로 강제한다**(엔진과 무관하게 걸린다). **memoryInjection을 연결해** dormant에서 active로 바꿨고, 모든 턴에 일반 주입이 걸리며 no-op 불변은 지켰다.
  - 셸 `slashCommands.ts`: **충돌 규칙**을 넣었다. `@등록에이전트명`은 하네스 `@verb` 확장을 건너뛰고 엔진 라우팅으로 넘어간다. `CommandExpansionStore`에 `getAgentByName`을 추가하고 `slashCommands.test`에 3케이스를 더했다.
  - 검증: 타입체크 clean(두 트리), slashCommands 유닛 13/13, spike-agents(파서 7 + 스토어 전부) PASS, `build:app` exit 0, 실서버 부팅 정상. **미검증: 실제 `@` 라우팅 턴 — system을 덮어쓰는지, toolRefs deny가 걸리는지, 메모리 주입이 라이브 모델 턴에 반영되는지. 라이브 모델이 필요하다.**
  - P3-M3으로 넘긴 것: autonomy(maxSteps 루프)와 텔레그램 에스컬레이션. 메모리는 지금 모든 스코프를 일반 주입하며, 에이전트 memoryScope로 좁히는 일은 P3-M4 학습에서 다듬는다.
- **P3-M3** ✅ **완료(M3a·M3b·M3c, 2026-07-25)** — 자율 모드와 에스컬레이션. 목표 루프, M2 승인의 **텔레그램 채널**, 최종 리포트를 붙였다(M2·scheduled·telegram 재사용).
  - **결정(2026-07-25, 개정)**: 텔레그램 설정은 naby 자체(store settings)에 두고 **naby 전용 봇을 @BotFather로 따로 만든다.** dotclaude 봇과 `messenger.json`에서 **완전히 분리한다**(사용자 요청). chat_id는 `detectChatId`로 자동 감지한다(naby 봇에 메시지를 한 번 보낸 뒤 감지). 에스컬레이션은 **양방향**이다. 텔레그램 인라인 버튼이나 답장으로 원격에서 승인을 해소한다.
  - **M3a ✅ 완료(커밋 대기)** — 텔레그램 채널의 기반을 셸에 만들었다. `lib/telegram.ts`에 설정 읽기·쓰기, `detectChatId` 자동 감지, 순수 헬퍼 buildApprovalKeyboard/parseCallbackData/classifyTextReply(en/ko), IO sendTelegramMessage/pollTelegramUpdates/answerCallbackQuery가 들어간다. api에 `telegram.get/set/test/detectChat`을 추가하고 토큰은 가린 채로만 내보낸다. `NabyTelegramSettings.tsx`(전용 봇 안내 + Detect 버튼)를 Settings Agents 섹션에 넣고 i18n `telegramSettings.*`를 추가했다. **dotclaude 결합은 제거했다**(seedTelegramFromDotclaude와 readDotclaudeMessengerConfig 삭제, getStore 프리필 연결 없음). 검증: 유닛 9/9, 타입체크 clean, `build:app` exit 0. 실제 봇 전송은 초기 공유 봇으로 한 번 성공했고, 분리 뒤에는 빈 설정 반환과 부드러운 실패를 확인했다.
  - **M3b ✅ 완료(2026-07-25, 커밋 대기)** — 에스컬레이션 배선. 전부 셸에서 한다.
    - 신규 `lib/telegramEscalation.ts`가 브리지다. 순수 함수는 `truncate`, `formatApprovalMessage`(툴과 입력 400자 미리보기, 평문으로 보낸다 — 툴 입력의 `_`나 `*`가 Markdown 파싱을 깨뜨린다), `formatFinalReport`(성공하면 답변 1200자, 실패하면 에러), `interpretUpdate`(callback·text·무시 판정에 watched 여부까지), `pickTextReplyTarget`(**가장 최근** escalatedAt), `telegramDecision`(deny 이유에 "from Telegram"을 남긴다)이다. IO는 `escalateApproval`(먼저 watch에 넣고 루프를 띄운 뒤 인라인 버튼을 보내며, 발송이 실패하면 watch에서 뺀다), `finishEscalation`(앱·abort·TTL이 먼저 해소하면 watch에서 빼고 채팅에 알린다. **watch에 없으면 아무것도 하지 않아** 중복 통지를 막는다), `sendFinalReport`, `ensureListener`(폴링 루프)다.
    - **폴링 루프는 참조 카운트 방식이다**(상시 켜두지 않는다). 대기 중인 승인이 하나 이상일 때만 `getUpdates`를 25초 long-poll로 돌리고, 마지막 승인이 해소되면 끝낸다. 이유는 두 가지다. 봇 하나당 `getUpdates`는 한 개만 허용되므로 상시 폴링하면 Settings의 **Detect가 409로 깨진다.** 그리고 쓰지 않는 소켓을 붙잡고 있을 이유가 없다. 반복 사이에 최소 2초를 두어 오류가 났을 때 빈 폴링이 폭주하지 않게 하고, 매 반복마다 설정을 다시 읽어 텔레그램을 끄면 루프도 끝난다.
    - **중복과 재전송을 막는 장치**는 두 겹이다. offset 워터마크를 store `telegram.updateOffset`에 저장하고, 프로세스당 한 번 **밀린 업데이트를 비운다.** 몇 시간 전에 보낸 "yes"가 새 승인을 해소하는 사고를 막는 장치다. watch map이 두 번째 방어선이라, 지켜보지 않는 id는 무시하고 버튼은 확인 응답만 보낸다. 상태는 `globalThis.__nabyTelegramBridge`에 둔다. approvalRegistry와 같은 realm 함정에 걸리기 때문이다.
    - `engines/naby.ts` 배선: `escalation = routedAgent?.autonomy.escalation ?? 'inline'`으로 읽어 telegram이나 both면 `escalateToTelegram`이 참이 된다. `requestApproval`에서 `approval_request`를 emit한 **직후 기다리지 않고** 텔레그램으로 보낸다(await하면 턴이 늦어진다). 해소는 `settle`에서 `finishEscalation`이 맡고, 턴이 끝나면 `sendFinalReport`를 **await한다**(프로세스가 정리되며 발송을 놓치는 경쟁을 막는다). 라우팅이 없는 일반 턴은 설정을 읽지도 않는다(byte-for-byte no-op).
    - 검증: 신규 유닛 15개에 기존 telegram 9개를 더해 lib 57/57, **셸 전체 261/261**, 타입체크 clean(두 트리, 베이스라인 노이즈만), `build:app` exit 0. `.next-prod`와 `dist` 번들에 브리지가 들어간 것을 확인했고, prod 서버를 띄워 `escalation:'both'` 에이전트 저장과 `telegram.get` 빈 설정을 확인했다. 브리지 전체 흐름(발송 → `getUpdates` → `resolveApproval(approvalId)` → 확인 응답과 확인 메시지 → offset 전진 → `finishEscalation`을 두 번 호출해도 한 번만 통지)은 fetch를 스텁으로 바꿔 검증했다. **미검증: 라이브 모델 턴에서 게이트가 실제로 에스컬레이션하는지, 실제 나비봇과 왕복하는지. 봇을 먼저 만들어야 한다.**
  - **M3c ✅ 완료(2026-07-25, 커밋 대기)** — 자율 루프(`autonomy.maxSteps`). 전부 셸에서 한다.
    - **정의**: 1 step은 모델 턴 하나다(`runTurn` 한 번 = `engine.run` 한 번과 그 안의 툴 루프). `maxSteps`는 사용자가 "계속"을 입력하지 않고 에이전트가 **스스로** 밟을 수 있는 턴 수다.
    - **루프는 엔진 dispatch 안에 둔다**(`engines/naby.ts`에서 runTurn을 감싸는 do/while). `/api/chat`으로 다시 dispatch해서 이어붙이면 자기 자신의 살아 있는 run에 **concurrent-run 409**가 걸리고, run 레지스트리가 목표 하나를 여러 엔트리로 쪼갠다. 그래서 목표 하나 = run 하나 = step N개다. MCP 툴셋, 게이트, 에스컬레이션, store 핸들은 루프 **밖에서** 한 번만 만든다. step이 아니라 목표에 속하는 것들이다. 세션 히스토리를 공유하므로 step N은 1번부터 N-1번까지가 한 일을 다 본다.
    - 신규 `lib/autonomy.ts`는 순수 함수만 담고 유닛 12개가 붙는다. `AUTONOMY_STEP_CAP=20`, `resolveMaxSteps`(undefined·0·1·NaN·∞은 1로, 20을 넘으면 20으로), `isAutonomous`, `DONE_MARKER='[[DONE]]'`와 `sawDoneMarker`, `autonomyInstruction`(system에 주입하는 프로토콜), `continuationPrompt`, `decideAutonomyStep`(우선순위는 aborted > error > done-marker > no-tool-use > max-steps), `stepMarker`.
    - **안전 규칙 세 가지.** ① 켜야 돌고, 켜도 상한이 있다. maxSteps가 없거나 1이면 기존 단일 턴 그대로여서 주입도 continuation도 없다(byte-for-byte no-op). ② **스스로 멈춘다.** 툴을 쓰지 않은 step은 "일하는 중"이 아니라 "답변"이므로 런을 끝낸다. 자기끼리 이야기하며 상한까지 도는 것을 막는 장치다. `[[DONE]]`으로 명시적으로 끝낼 수도 있다. ③ **자율은 권한이 아니다.** 모든 step의 모든 툴콜이 같은 게이트·정책·toolRefs allowlist를 지나고, 'ask' 규칙은 그대로 사람 승인(M3b 텔레그램 포함)에서 멈춘다.
    - **클라이언트 계약이 가장 중요하다.** 클라이언트는 `result`를 받으면 턴을 끝내므로 **중간 step의 result는 내보내지 않고** muted harness 바(`harness_subtype:'autonomy'`, `step k/N — continuing|stopped(reason)`)만 emit한다. result는 마지막 step에서 한 번만 나간다. 종료 판정은 `sawResult`가 아니라 새로 둔 `emittedResult`로 한다. step 사이에서 중단되면 fallback이 반드시 발동해야 턴이 영원히 도는 것을 막는다. 토큰과 비용은 run 전체를 합쳐 한 번 보고한다(step이 하나면 기존 값과 같다).
    - continuation은 `[naby autonomy] Continue toward the goal — step k of N…`이라는 **실제 user 메시지로 저장한다.** 모델을 실제로 구동한 것이 이 문장이므로, 트랜스크립트가 이를 숨기지도 않고 사용자가 입력한 척하지도 않게 라벨을 붙였다.
    - 최종 리포트(M3b)는 목표당 한 번 나가며 `steps`/`stepsMax`와 `stopReason`을 담는다(`done-marker`면 이유는 뺀다). 덕분에 "2/5 steps"와 "5/5 steps, max-steps"를 구분해 읽을 수 있다.
    - API와 UI: `agent.put`이 `resolveMaxSteps`로 **저장할 때도 상한을 자른다**(999는 20으로, 1과 0은 필드를 빼서 끈다). UI에 보이는 값이 곧 실행되는 값이다. `NabyAgentManager` placeholder를 `no limit`에서 `off (1 turn)`으로 고쳐 오해를 없애고 `agentManager.stepsHint`(en/ko)를 추가했다.
    - 검증: 신규 spike `spike:autonomy`가 **10/10 PASS**다. SPIKE-02와 같은 주입 seam으로 mock 모델을 넣고 실제 엔진·게이트·실행기를 돌린다. 확인한 것은 다단계 실행, continuation 트랜스크립트, **result가 정확히 하나**, `[[DONE]]` 조기 종료, no-tool-use 종료, maxSteps 하드 스톱(모델 호출 4회 = 2 step이며 6회가 아니다), no-op 불변(바 0개, result 1개, 주입 없음)이다. 회귀는 `spike:02` 5/5, `spike:agents`와 `spike:policy` PASS, 셸 274/274, 타입체크 clean(두 트리), `build:app` exit 0, 실서버 상한 확인이다. **미검증: 라이브 모델이 실제로 얼마나 잘 이어가는지. 모델이 필요하다.**
- **P3-M5** 🔶 **알고리즘 확정·코어 1차 구현(2026-07-25)** — 나비 신뢰 지표. 페르소나를 얼마나 믿고 맡길 수 있는지를 **측정해** 알·애벌레·번데기·나비로 표시하고, 나비만 `@`로 부를 수 있게 한다. 개수 누적이 아니라 체크인 적중률의 Wilson 하한 + 커버리지 + 트립와이어 + 작업유형별 범위로 판정한다. 자체 설계 + 논문(PRELUDE·Wilson·risk-coverage·ADWIN·ConfidenceBench·Goodhart) + 업계 표준(Anthropic·LangChain·OpenAI·Google)을 대조해 확정했다.
  - 알고리즘 상세 → [`phase-3-butterfly-trust-meter`](phase-3-butterfly-trust-meter.md). 원장 계약(P15-03 실체화) → [`phase-3-checkin-contracts`](phase-3-checkin-contracts.md).
  - 코어 1차: `src/runtime/growth.ts`, `npm run spike:growth` **14/14 PASS**. 남음: 원장 이원화·ADWIN·커버리지·작업유형별 범위, 체크인 배선, `@` 팔레트 노출·비활성, 설정 성장 패널.
  - ✅ **`@` 팔레트 결함 해소** — `/api/commands`가 하네스만 읽어 등록된 에이전트가 목록에 안 떴다(P3-M2가 라우팅만 배선하고 발견 경로를 안 만들었다). 에이전트를 최우선으로 반환하고 `/`에서는 제외하며, 단계 배지를 붙이고 나비가 아니면 회색으로 선택을 막는다.
  - ✅ **데드락 해소 — `growthSubject`와 `routedAgent`를 나눈다.** M4a는 학습을 라우팅된 턴에만 붙였고, 멘션 게이트와 합치면 페르소나는 지목될 수 없어 체크인도 못 하고 영원히 알이었다. 이제 두 개념을 나눈다.

    | | 무엇을 정하는가 | 언제 정해지는가 |
    |---|---|---|
    | `routedAgent` | 이 턴이 **채택하는 정체성** — 시스템 프롬프트, 모델, 도구 제한, 자율성 | `@이름`이 명시될 때만 |
    | `growthSubject` | 이 턴의 **관측이 귀속되는 곳** — 기억과 성장 원장 | 항상. 라우팅이 없으면 내장 페르소나 |

    평범한 턴은 페르소나의 턴이므로 페르소나가 배우고 체크인한다. **지목은 여전히 벌어야 한다** — 게이트가 지키려던 것이 그것이다. 커스텀 에이전트에게 맡긴 턴은 그 에이전트에 귀속된다(전문가가 한 일을 페르소나가 자기 실적으로 배우면 안 된다).
  - ✅ **체크인 배선** — `naby_checkin`(런타임), 일시정지 브리지(`checkinRegistry`, M2와 같은 기법), 게이트가 쓰는 `autonomous`/`tripwire` 행, 인라인 프롬프트 UI(추천은 답한 뒤 공개). 상세 → [`phase-3-butterfly-trust-meter`](phase-3-butterfly-trust-meter.md) §9, 계약 → [`phase-3-checkin-contracts`](phase-3-checkin-contracts.md).
  - ✅ **설정 성장 패널** — 단계 사다리·게이지·축·작업 유형별 분해·최근 결정 목록 + 후퇴 사유를 쉬운 한국어로. 상세 → [`phase-3-butterfly-trust-meter`](phase-3-butterfly-trust-meter.md) §9.
  - ⬜ 남은 것: 2차 축(물음 판단 정밀도·재현율, Brier 보정).
- **P3-M6** ✅ **내보내기 구현 완료(2026-07-26)** — 학습된 에이전트를 Claude Code 표준 서브에이전트 `.md` + 무손실 사이드카(`.naby.json`)로 내보낸다. 상세 → [`phase-3-agent-export`](phase-3-agent-export.md).
  - `src/runtime/agent-export.ts`(순수): 무엇을 빼는지, YAML 스칼라 인용, 사이드카 형태. `npm run spike:export` **11/11**.
  - 셸 `lib/agentExport.ts`: 어느 스코프를 모으는가(user 항상, project는 cwd 있을 때, session·org 절대 아님). `api/naby.ts` `agent.export`는 **읽기 전용**이라 아무것도 쓰지 않는다.
  - `AgentExportButton.tsx`: 두 단계. 첫 클릭은 보고만, 두 번째 클릭에서 저장한다.
  - 왕복을 **실제 임포터**(`parseSubagentArtifact`)로 검증한다. 형식을 추측하지 않았다는 주장이 테스트가 된다.
- **P3-M7** ✅ **임포트 구현 완료(2026-07-26)** — 사이드카를 읽어 에이전트를 복원하되, **파일은 신뢰를 선언할 수 없다.** 상세 → [`phase-3-agent-export`](phase-3-agent-export.md) §7.
  - 스펙의 §1(단계 재계산)과 §4(기본 비활성)가 충돌했고, **사용자에게 물어서** 풀었다. "내가 내보낸 파일입니까?"가 원장을 세는지 결정한다. 아니면 `imported` 플래그가 붙고 모든 성장 축이 무시한다 — 알은 `@`로 부를 수 없으니 "기본 비활성"이 지표에서 저절로 나온다.
  - **라이브에서 결함을 잡았다.** 임포트한 학습 내용을 메모리로 제안했더니 전부 거부됐다(불변식 3: external은 `user` 스코프를 못 쓴다). 옳은 거부이므로 설계를 고쳐 **그 에이전트의 지시문**에 넣는다. 순정 `.md`가 하는 것과 같다.
  - `npm run spike:import` **11/11**(대부분 적대적), 셸 `agentImport.test.ts` 6건.
- **P3-M4** 🔶 **M4a·M4b 구현 완료(2026-07-25, 커밋 대기)** — 학습. 페르소나 턴에서 배운 것을 메모리로 잡아 두고(쓰기 게이트) 다음 턴에 주입한다.
  - **진단**: Phase 1.5가 스토어·쓰기 게이트·주입을 다 만들고 P3-M2가 주입을 배선했는데, **행을 쓰는 코드가 하나도 없었다.** `decideMemoryWrite`는 런타임에 구현·export만 되어 있고 호출자가 없는 dormant 상태였다(M2 이전의 주입과 똑같다). 그래서 스토어는 영원히 비어 있고 검토 UI에도 재료가 없었다. 개인화 전략 §3.2가 "추출·검증 단계가 비었다"고 지적한 그 공백이다.
  - **M4a — 캡처 도구 `naby_remember`**(런타임 `tools.ts`). `naby_add_mcp`와 같은 선례를 따른다. 에이전트가 제안하고 사람이 승인한다.
    - **왜 도구인가**: 턴이 끝난 뒤 별도 모델 호출로 뽑는 방식과 달리, 에이전트는 이미 대화 중에 "지금 배웠다"를 안다. 추가 왕복이 없고, 트랜스크립트에 보이고, 무엇보다 **다른 툴콜과 똑같은 게이트를 지난다** — 정책 규칙으로 `naby_remember`를 deny하거나 승인 대상으로 만들 수 있다.
    - **게이트 두 겹**: ① 툴콜 게이트(Phase 2 정책) ② 쓰기 게이트(`decideMemoryWrite`, `store.putMemory` 내부에서 적용).
    - **오염 방어 3가지**: ① 모든 쓰기가 `requestedStatus:'proposed'`다. 주입은 `confirmed`만 되므로(계약 §5) **사람이 확인하기 전에는 어떤 답변도 바꾸지 못한다** — 전략 §2.3 "완전 자동 메모리는 만들지 않는다"를 코드로 강제한다. ② provenance는 `artifact` 등급이다. 모델이 "사용자가 X를 좋아한다"고 말하는 것은 사용자가 직접 말한 것과 다르므로 `user` 등급을 주지 않는다. ③ 시크릿 모양 값은 결정론적으로 거부한다(`looksLikeSecret` — sk-/Bearer/JWT/봇토큰/PEM/`password=`). `app.db` 암호화가 아직 미결(전략 §7.2)이라 토큰을 넣으면 평문 자격증명이 디스크에 남는다.
    - 순수 함수(스파이크 검증): `normalizeMemoryKey`(슬러그화 — "Prefers Dark Mode"와 "prefers-dark-mode"가 한 행으로 upsert되게, 한글 유지), `looksLikeSecret`, `resolveMemoryScopeKey`(scope→key는 계약 §2 사실이라 런타임에 둔다), `validateRememberInput`(값 400자 상한, type/scope 검증). `org` 스코프는 **에이전트에게 쓰기를 허용하지 않는다** — 팀 자산은 사람이 큐레이션한다.
    - `buildToolset(outbox, mcp?, memory?, checkin?)`에 학습 sink를 더했다. 처음에는 **라우팅된 에이전트 턴에만** 붙여 일반 턴의 도구 목록을 M4 이전과 byte-for-byte 같게 두었으나, P3-M5에서 그 결정이 데드락을 만들어 `growthSubject` 기준으로 바꿨다(위 참조). 일반 턴에도 `naby_remember`와 `naby_checkin`이 붙는다.
  - **M4b — 학습 지시 주입**(셸 `lib/learning.ts`, 유닛 7). 도구만 주고 지시를 안 하면 모델이 들쭉날쭉 부른다. 지시는 모델이 그냥 두면 틀리는 세 가지를 박는다. 캡처는 제안이라 "이제부터 적용됩니다"라고 말하면 안 되고, 기준은 "다음 주에도 참인가"이고, 시크릿은 메모리가 아니다.
    - **`canLearn` 게이트**: `toolRefs`로 제한된 에이전트가 `naby_remember`를 못 부르면 지시를 **주입하지 않는다.** 부를 수 없는 도구를 부르라고 지시하면 스킬 주입이 `availableTools`로 막는 "반쪽 실행"과 같은 문제가 된다. 비교 규칙은 P3-M2 게이트와 동일(현재 `normalizeToolName`은 항등이라 유사 이름 MCP 도구는 다른 도구다).
    - 도구의 기본 스코프는 `agent.memoryScope`다. **읽기(주입)는 계속 전 스코프 합집합으로 둔다** — 좁히면 품질만 떨어진다. `memoryScope`는 "어디에 쓰는가"를 정한다.
  - 검증: 신규 스파이크 `spike:learn` **10/10 PASS**. SPIKE-02와 같은 주입 seam으로 mock 모델을 넣고 실제 엔진·게이트·실행기를 돌려 **루프를 닫는 것까지** 확인한다. 캡처가 `proposed`+`artifact`로 안착 → **proposed는 다음 턴에 주입되지 않음** → 사용자 confirm → **같은 사실이 다음 턴 시스템 프롬프트에 등장**. 여기에 라우팅 없는 턴은 도구·지시 모두 없음, 시크릿 거부 후 미기록, `org` 거부, cwd 없는 턴의 `project` 거부까지 본다. 회귀: `spike:02` 5/5, `spike:autonomy` 10/10, `spike:agents`·`spike:p15`(11/11) PASS, 셸 281/281, 타입체크 clean(양 트리), `build:app` exit 0. **미검증: 라이브 모델이 무엇을 기억할 만하다고 판단하는지의 품질(모델 필요), Settings 검토 UI 시각 렌더.**
  - 남음(M4c): 모델 판단이 아니라 **편집·승인 신호에서 선호를 추출**하는 루프. 전략 문서가 Phase 2b(추출·검증)에 배치했고, 북극성 지표(편집률 감소 곡선)를 실제로 움직이는 부분이다. → **P3-M8(연속 학습)로 승계** — [`phase-3-continuous-learning`](phase-3-continuous-learning.md).
- **P3-M9** ✅ **완료(2026-07-30)** — 페르소나 하드닝. 편집 잠금(§4) 이후 위임 비전을 실행 가능하게 만들었다: 자율 설정의 사용자 소유권 이동(`persona.autonomy.*` 설정), `@` 게이트 일원화(`isAddressable` 한 함수를 팔레트·엔진이 공유), 시드 프롬프트 운영 프로토콜 4종, 자율 루프 검증 촉구. 상세 → [`phase-3-persona-hardening`](phase-3-persona-hardening.md).
- **P3-M8** ✅ **M8a~M8d 완료(2026-07-30)** — 연속 학습. 모든 세션의 대화록을 학습 증거로 바꾸는 루프. M8a(세션 회고 — 암묵 교정 `correctedAfter` 기록), M8b(기억 제안 + 교차 세션 확증·옵트인 자동 confirm), M8c(어휘 관련도 주입 랭킹 + 학습 깊이 패널 + 순수 대화 세션 회고), M8d(암묵 라벨 가중 편입 w=0.25 + MCP 결과성 분류)를 구현·검증했다. 남은 M8e(골든셋 재채점)는 라이브 judge 품질 실측 뒤로 보류. 상세 → [`phase-3-continuous-learning`](phase-3-continuous-learning.md).
- **P3-M10** — 기억 위생과 주권(감쇠·주권 컨트롤·기억 브라우저). 이 문서의 범위 밖이며 상세는 [`phase-3-memory-hygiene`](phase-3-memory-hygiene.md)에 있다.
- **P3-M11** ✅ **완료(2026-08-03)** — 나비 정체성 일원화. 내장 에이전트의 핸들을 `naby`(표시 '나비')로 바꾸고, 커스텀 에이전트 **생성** UI를 없앴다. 근거와 범위는 §8.2다.
  - 런타임: `BUILTIN_PERSONA_NAME`을 `'naby'`로 바꾸고 시드의 자기소개 줄을 "You are naby, the user's personal agent."로 고쳤다(운영 프로토콜 4종은 그대로다). `kind='persona'`와 `BUILTIN_PERSONA_ID`는 **그대로 둔다** — 불변식과 원장·기억·성장 기록이 전부 그 둘에 걸려 있다.
  - 이름은 **마이그레이션 없이** 부팅 시드가 옮긴다. `name`은 시드가 소유하는 필드라 기존 설치의 `persona` 행은 드리프트로 잡히고, 다음 부팅의 heal이 id와 createdAt을 유지한 채 `@naby`로 고쳐 쓴다.
  - 셸: Settings 섹션 이름을 '나비'/'Naby'로 바꾸고(아이콘 🦋 유지), 에이전트 추가 버튼과 빈 폼을 지웠다. 편집기는 남는다 — **가져온 커스텀 에이전트는 계속 목록에 뜨고 편집·삭제된다**. 추가 버튼 자리에는 "특정 역할은 하네스 서브에이전트" 한 줄을 둔다.
  - 검증: `spike:agents`가 이름 heal과 **충돌 양보**(사용자가 `@naby`를 이미 쥔 설치)를 두 드라이버에서 확인한다. `spike:autonomy`는 핸들을 상수에서 읽도록 고쳤다(이름이 안 맞으면 라우팅이 조용히 빠져 검사 대상이 달라진다). 셸 1275/1275, 타입체크 clean(양 트리), `build:app` exit 0.

## 8. 결정 사항 (2026-07-25 확정)

- ✅ **페르소나 에이전트는 별도 `agents` 스토어의 1급 엔티티다**(§4). 하네스 subagent를 재사용하지 않는다. "에이전트는 하네스가 아니다"라는 구분을 코드로 못박는다. built-in 페르소나 하나를 시드로 넣고 사용자는 custom을 추가한다.
  - ⚠️ **2026-07-30 개정**: 원래 결정은 "삭제 불가, 편집 가능"이었다. **삭제·편집 모두 불가로 바꾼다**(아래 결정 참조).

## 8.1. 결정 사항 (2026-07-30 사용자 결정)

- ✅ **built-in 페르소나는 삭제도 편집도 할 수 없다. 시드가 기본값을 강제한다.**
  - 왜 뒤집는가: 페르소나의 systemPrompt는 M2~M8이 그 위에 쌓은 **계약 그 자체**다. 기억 주입, 에스컬레이션, 자율 단계 예산, 신뢰 지표가 재는 대상이 전부 이 프롬프트를 전제한다. 사용자가 절반쯤 고친 프롬프트는 **측정 대상과 다르게 행동하는 에이전트**를 만들고, 그 행을 지울 수도 없으니 되돌릴 길이 없었다. 내장·읽기 전용으로 두면 계약을 제품이 지킨다.
  - 페르소나는 **고쳐 써서** 자라지 않는다. **배워서** 자란다 — 기억(P15/M8b)과 원장(M5)이 그 통로이고, 그쪽은 그대로 열려 있다.
  - 이전 빌드에서 이미 편집된 행은 다음 부팅의 시드가 **되돌린다**(§4). 한 기계만 계약 밖에 남는 상태를 만들지 않는다.
  - 예외 하나: 시드 이름(`persona`)을 다른 custom 에이전트가 이미 쥐고 있으면 이름만 그대로 두고 나머지를 되돌린다. 사용자가 만든 행을 건드리거나 부팅을 깨뜨리는 쪽이 더 나쁘다.
- ✅ **구현은 새 세션에서 한다**(컨텍스트를 넉넉히 두려고). 이 문서가 착수 스펙이다.

## 8.2. 결정 사항 (2026-08-03 사용자 결정)

- ✅ **페르소나의 이름은 `naby`다(표시 '나비').** 이 에이전트는 제품이 담고 있는 여러 역할 중 하나가 아니라 **제품 그 자체**다. `@persona`라는 핸들은 그것을 역할 하나로 부르는 이름이었고, 설정 섹션 제목 '에이전트'도 같은 오해를 만들었다.
  - 바뀌는 것은 **이름과 표시뿐이다.** `kind='persona'`는 타입 판별자로 그대로 두고 `BUILTIN_PERSONA_ID`도 그대로 둔다. 삭제·편집 금지(§8.1), 단일 행 불변식, 원장·기억·성장 기록이 전부 그 둘에 걸려 있어서, 이름을 옮기려고 식별자를 건드리면 잃는 것이 이름보다 크다.
  - 기존 설치는 **부팅 heal이 옮긴다**(§4). `name`은 시드가 소유하는 필드라 `persona` 행은 드리프트로 잡히고, id와 createdAt을 유지한 채 `@naby`로 고쳐진다. 별도 마이그레이션을 쓰지 않는다.
  - 이름 충돌 양보(§8.1)는 그대로 적용된다. 사용자가 이미 `@naby`라는 커스텀 에이전트를 쥐고 있으면 **이름만 예전 그대로 두고** 나머지를 되돌린다. 부팅을 깨뜨리거나 사용자가 만든 행의 이름을 뺏는 쪽이 더 나쁘다.
- ✅ **커스텀 에이전트 생성 UI를 없앤다. 런타임과 임포트 호환은 유지한다.**
  - 왜인가: 사용자가 손으로 만든 커스텀 에이전트도 **나비와 똑같은 신뢰 게이트**를 지나야 `@`로 불린다. 즉 만들자마자 알이고, 자라기 전에는 부를 수 없다. 그런데 사람들이 커스텀에 기대한 것은 "전문 역할"이고, 그 자리는 **하네스 서브에이전트**가 이미 맡고 있다. 서브에이전트는 업계 표준 용어라 그대로 쓴다.
  - 그래서 나비 레이어의 에이전트는 **하나**다. 나비다.
  - 없애는 것은 **생성 경로뿐이다.** `kind='custom'` 행은 런타임에 그대로 있고, 임포트는 계속 그것을 만들며, 목록·편집·삭제·성장·내보내기도 그대로 동작한다. 다른 기기에서 가져온 에이전트를 쓰지 못하게 만드는 것은 이 결정의 목적이 아니다.
  - `agent.put` API는 그대로 둔다(페르소나 행은 여전히 거부한다). 편집이 그 API를 쓰고, 생성은 UI에서만 사라진다.

### 착수 시 남은 세부 결정 (P3-M1에서 확정)
1. `@` 충돌 정리 규칙: **등록된 에이전트 이름 > 하네스 subagent(`@verb`) > 파일 참조**. 줄 맨 앞의 `@name`이 등록된 agent면 라우팅하고, 아니면 기존 동작을 따른다.
2. 자율 실행 안전장치: `autonomy.maxSteps` 상한, 모든 툴콜에 M1/M2 게이트 강제, 텔레그램 승인이 반드시 필요한 도구 목록.
3. 텔레그램 통합 방식: naby 런타임에 채널을 새로 만들지, 기존 dotclaude-messenger에 브리지를 놓을지 — 착수할 때 조사한다.

### 착수 순서
**P3-M1부터 시작한다.** `agents` 스토어(store.ts와 두 드라이버) → built-in 페르소나 시드 → runtime-entry export → 셸 `/api/agents` CRUD → Settings "에이전트" 섹션(메모리 이동, 커맨드를 하네스로 흡수) → spike-agents 검증. M1부터 M4까지 각각 한 세션 분량이다.
