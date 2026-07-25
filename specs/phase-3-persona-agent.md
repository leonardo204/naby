# Phase 3 — Personal Persona Agent (naby 자체 에이전트 레이어)

> 상태: 설계 초안 (2026-07-25). 프로젝트의 궁극 목표를 구조로 옮기는 피벗.
> 한 줄: naby를 "하네스(도구) 지원 환경"에서 → "사용자를 대리하는 **페르소나 에이전트**를 내장한 제품"으로.

## 1. 목표 (사용자 정의)

- naby **자체**의 에이전트 레이어를 신설. **페르소나 에이전트**가 기본 내장, 사용자가 에이전트를 필요 시 하나씩 추가.
- 페르소나 에이전트는 사용자의 판단·행위·행동을 **학습**해, 지시받으면 사용자를 **대리 수행**하고, 크리티컬한 상황만 위임(에스컬레이션), 중간 알림(텔레그램), 마지막에 보고.
- 예: `@페르소나 이 테스트 90% 도달까지 처리하고, 크리티컬 아니면 알아서 해. 꼭 판단 필요하면 텔레그램으로 알리고 마무리 후 보고.`

## 2. 두 레이어 (재정의)

| 레이어 | 소유 | 구성 | 호출 |
|---|---|---|---|
| **naby 에이전트 레이어** (신설) | naby 자체 | 내장 **페르소나 에이전트** + 사용자 추가 에이전트. **메모리는 여기로 이동**(에이전트의 학습 기억) | **`@`** — 파일 참조처럼, `@에이전트명 <지시>` 로 그 에이전트에게 위임 |
| **하네스 레이어** (기존) | 사용자 naby-layer | **command / skill / subagent** (skill을 하네스 하부 카테고리로) | **`/`** — 하네스 스킬/서브에이전트/커맨드 호출 |

즉: `/` = 도구(하네스), `@` = 에이전트(+파일 참조). 메모리 = 에이전트 소속. 스킬 = 하네스 소속.

## 3. 기존 자산 매핑 (대부분 부품이 이미 있음)

- **에이전트 실행** = M4 서브에이전트 오케스트레이션(runTurn + systemPrompt + toolRefs). 페르소나 에이전트 = **naby-소유 1급 에이전트**(사용자 하네스 subagent와 별개, 기본 시드).
- **학습/기억** = 메모리 시스템(store `memory_items`, 쓰기 게이트 `decideMemoryWrite`, 주입 `retrieveMemories`). ⚠️ 주입이 셸에 **미배선**(스킬과 동일 dormant) → 페르소나 턴에 주입 배선 필요.
- **에스컬레이션** = **M2 승인 브리지 재사용**. 인라인 프롬프트 대신(또는 병행) **텔레그램 out-of-band** 채널로 배달 + 답신으로 resolve. `approvalRegistry`는 이미 out-of-band resolve 지원.
- **자율 실행(90%까지 알아서)** = 목표 주도 루프(ralph/`/loop`식 persist-until-done) + 기존 **scheduled tasks** 인프라.
- **알림/보고** = 텔레그램(현재 dotclaude-messenger는 외부 커맨드 — naby 런타임엔 텔레그램 없음 → 통합 필요) + 최종 리포트 메시지.
- **정책 게이트** = M1/M2 그대로 상속(에이전트 툴콜도 게이트 통과).

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
- 최초 실행 시 **built-in 페르소나 에이전트 1개 시드**(삭제 불가, 편집 가능).

## 5. 호출 라우팅 (`@`)

- `ChatInput`/디스패치에서 줄이 `@<agentName> ...` 로 시작하면 → 그 에이전트로 턴 라우팅.
  - ⚠️ 현재 `@`는 (a) 서브에이전트 커맨드(`@verb`), (b) 파일 절대경로 삽입에 씀. **충돌 정리 필요**: `@에이전트명`(등록된 agent) > `@하네스subagent` > 파일. 등록 에이전트명 우선 매칭.
- 라우팅 시 turn = 에이전트 systemPrompt + 주입 메모리 + 에이전트 toolRefs + autonomy 모드. `resolveCommandPrompt`/runTurn 확장.

## 6. Settings 재편

- 신설 **"에이전트"** 섹션: 내장 페르소나 + 추가/편집, **메모리를 이 아래로 이동**(NabyMemoryReview).
- **하네스** 섹션에 **커맨드/스킬/서브에이전트 서브탭** 통합(현재 분리된 "커맨드" 섹션 흡수, skill은 이미 하네스 소속).
- 결과 nav: theme·language·provider·**Agents(페르소나+메모리)**·**Harness(command/skill/subagent)**·Permissions·about.

## 7. 마일스톤 (Phase 3)

- **P3-M1** ✅ **구현 완료(2026-07-25, 커밋 대기)** — 데이터 모델(`agents` 스토어) + built-in 페르소나 시드 + Settings "에이전트" 섹션 + 메모리 이동 + 커맨드→하네스 흡수. (구조 재편, 실행 없음)
  - 런타임: `store.ts` Agent/AgentInput/AgentKind/AgentEscalation/AgentAutonomy + `listAgents/getAgent/getAgentByName/putAgent/removeAgent`(양 드라이버), `agents.ts`(BUILTIN_PERSONA_ID/SEED/seedBuiltinPersona, 페르소나 undeletable=store 강제), runtime-entry export, `spike-agents`(30체크×2드라이버+재오픈 무중복 PASS).
  - 셸: `getStore()` 합성루트에 `seedBuiltinPersona` 배선(멱등), `api/naby.ts` `agent.list/put/remove` 액션, `NabyAgentManager.tsx`(신규), Settings `agents` 섹션(메모리 이동)+`harness` 섹션(커맨드 흡수), i18n `agentManager.*`(en/ko).
  - 검증: 타입체크 clean(양 트리, 베이스라인 노이즈만), `build:app` exit 0, 실서버 부팅 후 `/api/naby` agent.list=시드확인/put/삭제불가 페르소나/중복명 거부 전부 통과. **미검증: Settings UI 시각 렌더(라이브 창 필요).**
  - 결정: 페르소나 kind='persona' 유일(사용자는 custom만 생성), name=@라우팅 핸들(UNIQUE, 공백 불가), memoryScope=학습 스코프(P3-M2 주입 배선 예정), escalation=inline(텔레그램 P3-M3).
- **P3-M2** — `@에이전트` 라우팅: 지정 에이전트로 턴 실행(systemPrompt+메모리 주입+toolRefs). 메모리 자동 주입 배선. (M3/M4 재사용)
- **P3-M3** — 자율 모드 + 에스컬레이션: 목표 루프 + M2 승인의 **텔레그램 채널** + 최종 리포트. (M2/scheduled/telegram)
- **P3-M4** — 학습: 페르소나 턴에서 사용자 판단/행위를 메모리로 캡처(쓰기 게이트) + 다음 턴 주입 강화.

## 8. 결정 사항 (2026-07-25 확정)

- ✅ **페르소나 에이전트 = 별도 `agents` 스토어 1급 엔티티** (§4). 하네스 subagent 재사용 아님 — "에이전트 ≠ 하네스" 구분을 코드로 명확히. built-in persona 1개 시드(삭제 불가·편집 가능) + 사용자 custom 추가.
- ✅ **구현은 새 세션에서** (컨텍스트 여유 확보). 이 문서가 착수 스펙.

### 착수 시 남은 세부 결정 (P3-M1에서 확정)
1. `@` 충돌 정리 규칙: **등록 에이전트명 > 하네스 subagent(@verb) > 파일 참조**. 라인 시작 `@name`이 등록 agent면 라우팅, 아니면 기존 동작.
2. 자율 실행 안전장치: `autonomy.maxSteps` 상한 + 전 툴콜 M1/M2 게이트 강제 + 텔레그램 필수-승인 도구 목록.
3. 텔레그램 통합: naby 런타임 신규 채널 vs 기존 dotclaude-messenger 브리지 — 착수 시 조사.

### 착수 순서
**P3-M1부터**: `agents` 스토어(store.ts + 양 드라이버) → built-in persona 시드 → runtime-entry export → 셸 `/api/agents` CRUD → Settings "에이전트" 섹션(+메모리 이동, 커맨드→하네스 흡수) → spike-agents 검증. (M1~M4 각 세션 분량)
