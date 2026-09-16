---
id: subagent-delegation
type: design
version: 0.1.1
status: draft
scope: 값싼 내장 서브에이전트(탐색 haiku·구현 sonnet)와 위임 정책으로 메인 대화 기록을 작게 유지하는 것, 서브에이전트가 실제로 쓴 모델을 보이게 하는 것, 엔진 동작을 바꾸는 환경변수를 드러내는 것
related:
  - model-auto-routing
  - harness-standalone
  - naby-activity-log
  - phase-2-2.5-plan
  - skill-hub-builtin
  - claude-multi-account
  - phase-3-persona-agent
  - settings-ia-reorg
updated: 2026-09-16
---

# 서브에이전트 위임과 모델 관측

## 1. 문제

[model-auto-routing](model-auto-routing.md)은 턴의 응답 모델을 고른다. 그것으로 줄지 않는 비용이 하나 남는다. 메인 대화 기록이다. 모델이 파일을 열고 검색하고 테스트를 돌리면 그 출력이 기록에 쌓이고, 턴마다 새 `query()`가 그 기록을 통째로 다시 보낸다. 대화가 40k 토큰을 넘으면 라우터는 이전 등급을 유지하므로(§4.2 규칙 2), 기록이 커진 세션은 결국 opus에 붙어 있게 된다.

서브에이전트는 자기 창에서 돌고 결론만 메인 기록에 남긴다. naby는 이미 서브에이전트마다 `model`을 둘 수 있고 엔진이 그것을 Agent SDK의 네이티브 에이전트로 넘긴다. 없는 것은 셋이다. 값싼 서브에이전트가 기본으로 들어 있지 않고, 메인 모델에게 언제 위임하라는 말이 없으며, 서브에이전트가 실제로 어느 모델로 돌았는지 아무 데도 남지 않는다.

세 번째가 사용자의 우려와 닿는다. Claude Code는 서브에이전트 모델 해석 순서를 버전마다 바꿔 왔다. 호출 시 `model` → 정의의 `model`(`inherit` 포함) → `CLAUDE_CODE_SUBAGENT_MODEL` → 메인 모델이 지금 순서이고, 2.1.251 이전에는 환경변수가 맨 앞이었다. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`은 전부를 덮는다. naby는 SDK 0.3.259(번들 CLI 2.1.259)를 고정해 쓰므로 어느 순서가 적용되는지는 SDK를 올릴 때마다 달라질 수 있다. 우선순위에 기대는 코드는 SDK를 올리는 날 조용히 뒤집힌다.

## 2. 원칙

1. **우선순위에 기대지 않는다.** 특정 모델이 그 서브에이전트의 존재 이유일 때만 `model`을 적는다. 탐색용은 haiku, 구현용은 sonnet이다. 그 밖의 서브에이전트는 비워 둔다. SDK 타입 문서대로 비운 값은 "기본 서브에이전트 모델이 설정돼 있으면 그것, 아니면 메인 모델"이라 Claude Code의 설정을 그대로 따라간다. naby는 `inherit`를 스스로 쓰지 않고, 모델을 **정하는 데** 환경변수를 쓰지 않는다. 사용자가 적은 `inherit`는 그대로 넘긴다. 환경변수를 읽는 곳은 4.4의 진단 표시 하나뿐이고 그 값은 어떤 결정에도 쓰이지 않는다.
2. **덮어써질 수 있음을 인정하고 보이게 한다.** `_FORCE=1`이나 옛 우선순위 아래에서는 naby가 적은 모델이 무시될 수 있다. 막지 않는다. 대신 서브에이전트가 실제로 답한 모델을 화면과 활동 로그에 남겨 드리프트가 조용하지 않게 한다.
3. **위임의 이유는 기록 크기다.** 위임은 opus 호출을 줄이지 않는다. 메인이 여전히 전체 기록을 받고 위임을 판단한다. 위임이 줄이는 것은 도구 산출물이 메인 기록에 쌓이는 것이다. 그래서 정책은 "읽고 찾는 일은 위임한다"이지 "쉬운 일은 위임한다"가 아니다.
4. **결론만 돌아온다.** 서브에이전트가 파일을 통째로 돌려주면 위임한 보람이 없다. 탐색 서브에이전트의 프롬프트는 경로·행 번호·짧은 발췌만 돌려주게 못박는다. 이 저장소의 confluence-researcher가 같은 형식이다.
5. **게이트는 그대로다.** 서브에이전트의 도구 호출은 그 턴의 게이트를 지난다. 변경 허용이 꺼졌거나 플랜 모드면 구현 서브에이전트도 편집하지 못한다. 위임이 정책을 우회하는 길이 되지 않는다.
6. **새 것은 새 이름으로 넣는다.** 내장 하네스는 한 번 심으면 다시 쓰지 않는다. 기존 `confluence-researcher`의 모델을 고쳐도 설치된 기계에는 닿지 않는다. 그래서 새 묶음과 새 이름으로 넣는다.

## 3. 확인한 사실

- 서브에이전트 정의의 `model`은 별칭·전체 id·`inherit` 중 하나이거나 생략이다. 생략은 "기본 서브에이전트 모델이 있으면 그것, 없으면 메인 모델"이다(`sdk.d.ts` `AgentDefinition.model`).
- 번들 CLI 2.1.259 바이너리에 `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{FABLE,HAIKU,OPUS,SONNET}_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` 문자열이 있다. 이 목록이 진단 화면이 말할 수 있는 전부다.
- naby는 계정을 고르지 않았으면 SDK가 프로세스 환경을 상속하고, 골랐으면 그 위에 설정 디렉터리만 얹는다(`buildQueryOptions`). 셸 환경의 위 변수들은 naby가 띄운 CLI에 그대로 닿는다. `settingSources: []`라 `~/.claude/settings.json`의 `env` 블록은 닿지 않는다([harness-standalone](harness-standalone.md) §2.3).
- 내장 하네스는 `src/runtime/harness-assets/*.md`를 `scripts/gen-builtin-harness.mjs`가 `generated.ts`로 굳히고, `seedBuiltinHarness`가 **없는 것만** 심는다(`harness-seed.ts:213-221`). 묶음(`BUILTIN_HARNESS_BUNDLES`)별로 `applyBuiltinHarnessActivation`이 켜고 끄되, 사용자가 손댄 행은 영원히 사용자 것이다.
- `gatherSubagents`(`engines/naby.ts:291`)가 저장된 서브에이전트를 엔진 입력으로 옮기는 유일한 자리이고, `effectiveAgentModel`이 `auto`와 빈 값을 걸러 `inherit`는 통과시킨다. `buildQueryOptions`는 `model`이 있을 때만 SDK에 적는다.
- `tools`를 적으면 `sdkAgentTools`가 naby 도구는 `mcp__nabytools__*`로 바꾸고 `Read`·`Glob`·`Grep` 같은 SDK 내장 이름은 그대로 통과시킨다. `tools`를 비우면 부모의 도구 전부를 물려받는다.
- 게이트: 변경 허용이 켜지고 플랜 모드가 아니면 바탕 정책이 allow-all이고, 아니면 `phase1HarnessFloor`가 `Bash`·`Write`·`Edit`와 naby의 변경 도구를 막는다(`engines/naby.ts:1785`). 이 게이트는 서브에이전트 안의 호출도 본다(`spike-subagent-gate`). `Task`는 관측 내장으로 허용된다.
- dev-claude의 시스템 프롬프트(`turnSystem`, `engines/naby.ts:1684`)에는 서브에이전트 목록도 위임 정책도 없다. 모델은 SDK `agents` 맵의 `description`으로만 서브에이전트를 안다. 다른 엔진은 `naby_delegate` 도구의 설명(`src/runtime/delegate.ts:271`)이 목록과 정책을 겸한다.
- 엔진은 `parent_tool_use_id`가 있는 assistant 메시지(서브에이전트 출력)의 `message.model`을 받지만 읽지 않는다(`claude-agent-sdk-engine.ts:1945`, 메인 스레드만). 활동 로그의 `harness` 이벤트는 [naby-activity-log](naby-activity-log.md) §3.3이 일부러 남기지 않는 것이라 새 종류가 필요하다.
- 클라이언트의 `SubagentTask`·`SubagentGroup`에는 모델 필드가 없고 `SubagentBlock`의 제목은 `Subagent · <type>`이다.

## 4. 설계

### 4.1 내장 묶음 `core`

`BUILTIN_HARNESS_BUNDLES`에 `core` 묶음을 더한다. 지금까지의 묶음은 전부 System MCP 프리셋의 스위치였다([skill-hub-builtin](skill-hub-builtin.md) §2.7). `core`는 프리셋이 없는 첫 묶음이라 새 범주가 필요하다. 런타임이 `ALWAYS_ON_HARNESS_BUNDLES = ['core']`를 소유하고, 시드 호출부는 `[...configuredHarnessBundles(store), ...ALWAYS_ON_HARNESS_BUNDLES]`를 넘긴다. 프리셋 순회 코드에는 분기가 생기지 않는다.

시드 의미론은 그대로다. 행은 첫 시드에 한 번 만들어지고 활성화가 `enabled`로 뒤집는다. 그 뒤 사용자가 끄거나 지우면 다음 부팅에도 그 상태다. "부팅마다 켜진다"가 아니라 "첫 시드에 켜져서 도착하고 그 뒤로는 사용자 것"이다.

이름이 이미 있으면 내장은 심지 않는다. 시드는 상태와 무관하게 이름으로 찾으므로, 사용자가 먼저 `explorer`를 가져왔으면 그 행이 이긴다. 프로젝트 스코프의 같은 이름이 사용자 스코프를 덮는 규칙도 그대로다. 내장은 자리를 다투지 않는다.

두 서브에이전트는 **dev-claude 전용**이다. 저장된 서브에이전트는 두 엔진에 같이 공급되는데, ai-sdk에서는 `Read`·`Glob`·`Grep`이 naby 런타임 도구 이름과 하나도 맞지 않아 도구 없는 서브에이전트가 되고 `haiku`가 Anthropic 아닌 프로바이더로 나간다. 그래서 하네스 자산에 `engines` 필드를 둔다(쉼표 목록, 비우면 모든 엔진). 생성 스크립트가 파싱해 `subagent.engines`로 저장하고, `gatherSubagents`가 그 턴의 엔진으로 거른다. 걸러진 이름은 목록에 없으므로 위임 정책(4.2)도 저절로 빠진다.

| 이름 | model | tools | 역할 |
|---|---|---|---|
| `explorer` | `haiku` | `Read, Glob, Grep` | 코드베이스·로그·문서를 읽고 찾아 **경로·행 번호·짧은 발췌**만 돌려준다 |
| `implementer` | `sonnet` | 비움(부모 전부) | 완전히 명세된 자족적 코드 변경을 수행하고 **바뀐 파일과 검증 출력 요약**만 돌려준다 |

두 파일은 `src/runtime/harness-assets/agents/explorer.md`, `implementer.md`이고 생성 스크립트의 `SOURCES`에 들어간다. 프롬프트는 영어다. 두 프롬프트 모두 마지막 절이 "반환 형식"이고, 중간 산출물을 돌려주지 말라는 문장이 있다. `explorer`의 `description`은 "언제 쓰는가"를 말한다. 모델이 백엔드의 `general-purpose` 대신 이것을 고르게 하려면 설명이 구체적이어야 한다. `general-purpose`는 메인 모델을 물려받아 아무것도 아끼지 않는다.

`implementer`의 `tools`를 비우는 이유는 편집·실행 도구가 턴마다 다르기 때문이다. 변경 허용이 꺼지거나 플랜 모드인 턴에는 naby의 변경 도구가 빠지고, SDK 내장 `Bash`·`Write`·`Edit`는 남되 게이트가 호출마다 거절한다. 켜진 턴에는 부모와 같은 도구를 받는다. 목록을 적으면 그 차이를 두 번 관리해야 한다. 그래서 위임 정책(4.2)은 변경이 허용된 턴에만 implementer를 권한다. 거절당할 서브에이전트를 권하는 것은 비서가 고장 난 것처럼 보이게 하는 일이다.

### 4.2 위임 정책

정책 문장은 런타임 상수 하나다(`src/runtime/delegation-policy.ts`, `DELEGATION_POLICY`). 두 곳이 같은 상수를 쓴다.

- dev-claude: `turnSystem`에 블록 하나를 더한다. 자리는 `handoffInstruction` 뒤, `stageInstruction` 앞이다. 그 배열은 맥락(인계)이 정책을 덮지 못하도록 순서를 정해 두었고 위임 정책은 정책 쪽이다. 목록에 `explorer`나 `implementer`가 실제로 있을 때만 넣는다. 없는 서브에이전트를 가리키는 정책은 모델을 헷갈리게 한다.
- 다른 엔진: `delegateSchema`의 설명 끝에 같은 문장을 붙인다. 조건도 같다. 4.1의 엔진 필터 때문에 오늘은 dev-claude에서만 문장이 생긴다.

`delegationPolicyFor(names, { canMutate })`가 문장을 만든다. explorer 문장은 `explorer`가 목록에 있을 때, implementer 문장은 `implementer`가 있고 그 턴이 변경을 허용할 때만 들어간다.

문장의 뜻은 이렇다. 여러 파일을 읽거나 찾아야 하거나 도구 출력이 길어질 일은 `explorer`에 맡기고 그 요약으로 일한다. 완전히 명세된 자족적 코드 변경은 `implementer`에 맡긴다. 파일 한두 개를 읽거나 짧게 답할 일은 직접 한다. 서브에이전트는 이 대화를 보지 못하므로 과제에 경로·제약·완료 조건을 다 적는다.

v0.1.1에서 문장 하나가 더 붙었다. 서브에이전트는 이 대화보다 작은 모델로 돌므로, 한 번에 좁고 기계적인 과제 하나만 주고 판단은 맡기지 않으며, 무엇을 어떤 형식으로 돌려줄지 적어 주고, 돌아온 보고는 인용된 경로와 행을 열어 확인한 뒤에 쓴다. [model-auto-routing](model-auto-routing.md) 원칙 8이 haiku를 메인 대화에서 뺀 날의 관찰이 근거다. haiku는 말투와 맥락을 지켜야 하는 자리에서는 무너지지만, 지시가 다 적힌 좁은 과제를 정해진 형식으로 돌려주는 자리에서는 값을 한다. 그 자리가 서브에이전트다. 이 문장은 메인 모델이 그 조건을 지키게 한다.

정책은 권고이지 강제가 아니다. 모델이 위임하지 않아도 턴은 실패하지 않는다.

**`@explorer …`처럼 사람이 직접 지목한 줄**은 위임 지시로 바뀐다. 지금까지 `@<하네스 서브에이전트>` 줄은 그 서브에이전트의 시스템 프롬프트를 메인 세션에 페르소나로 인라인했다. 네이티브 서브에이전트가 없던 때의 임시 동작이고, `core`가 모든 설치에 도착하면 "이 대화를 볼 수 없다", "편집할 수 없다" 같은 문장이 메인 턴의 지시가 되어 버린다. 그래서 `@` 표시가 붙은 서브에이전트 단계는 `"<이름>" 서브에이전트에 위임하고 직접 하지 말라`는 한 줄로 확장한다. 단계 머리말의 "(subagent로 실행)"이 그제야 사실이 된다. `/<서브에이전트>`(슬래시)는 지금처럼 메인 세션이 페르소나를 채택한다. [phase-3-persona-agent](phase-3-persona-agent.md) §5의 우선순위(등록 에이전트 > 하네스 서브에이전트 > 파일)는 그대로다.

### 4.3 서브에이전트가 실제로 쓴 모델

엔진이 `parent_tool_use_id`가 있는 assistant 메시지에서 `message.model`을 읽는다. 같은 `parent_tool_use_id`에 대해 한 번만 새 이벤트를 낸다.

```ts
{ kind: 'subagent_model'; agentToolCallId: string; model: string }
```

`agentToolCallId`는 기존 `text` 이벤트의 귀속 키와 같다. 클라이언트가 같은 키로 블록을 찾는다.

계약의 나머지는 이렇다.
- 이 이벤트는 dev-claude에서만 난다. ai-sdk의 중첩 턴은 자식 세션으로 돌아 자기 `turn_*`·`usage`를 남기므로 따로 내지 않는다. [naby-activity-log](naby-activity-log.md) §3.3이 피하려는 "엔진마다 다른 로그 모양"은, 한쪽에는 이벤트가 있고 다른 쪽에는 같은 정보가 다른 이름으로 있는 상태다. 이 사실을 두 스펙에 같이 적는다.
- 엔진 이벤트에는 `agentType`이 없다. assistant 메시지에는 없고 위임 도구 호출 입력(`subagent_type`)에만 있어서다. 그 도구의 이름은 SDK 문서에서는 `Task`이고 번들 CLI 2.1.259가 실제로 내는 이름은 `Agent`다. `runTurn`이 두 이름 모두 호출 id로 기억해 두었다가 활동 로그 행에 `agentType`을 붙인다. 클라이언트는 블록이 이미 `agentType`을 알고 있으므로 제목에 합치는 데 문제가 없다.
- 위임이 assistant 메시지를 하나도 내지 못하고 실패하거나 중단되면 이벤트도 없다. 없음은 "모델을 확인하지 못했다"이다.
- `EngineEvent` 유니온(`src/runtime/engine.ts`)과 `ActivityKind` 유니온(`src/runtime/activity-log.ts`) 양쪽에 종류가 들어간다.

- 런타임 `runTurn`이 이 이벤트를 활동 로그에 `subagent_model` 종류로 남긴다. 페이로드는 `sessionId`, `agentToolCallId`, `model`, 알 수 있으면 `agentType`이다. [naby-activity-log](naby-activity-log.md) §3.1 표에 한 줄이 늘어난다(가산 개정 v0.1.1).
- 셸은 SDK 모양 이벤트로 전달한다. `{ type: 'subagent_model', session_id, agent_tool_call_id, model }`이다.
- 클라이언트는 `SubagentTask`와 `SubagentGroup`에 `model?`을 더하고, 블록 제목을 `Subagent · explorer · haiku`처럼 쓴다. 모델 id는 아는 등급이면 등급 이름으로, 모르면 id 그대로 보인다. 블록을 만든 `Task` 호출이 항상 서브에이전트의 첫 메시지보다 앞서므로 블록 없이 도착하는 이벤트는 없다. 그래도 도착하면 버린다.

이것이 원칙 2의 구현이다. `_FORCE`가 걸려 있거나 SDK를 올려 순서가 바뀌면 제목의 모델이 달라져 보인다.

### 4.4 엔진 환경변수 진단

런타임에 `engineEnvironmentNotes(env)`를 둔다. §3의 목록 가운데 **설정된 것만** 돌려준다. 각 항목은 이름, 표시값, 한 줄 효과다. 모델·effort 변수는 값을 보이고, `CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY`는 "설정됨"만 보인다. `ANTHROPIC_API_KEY`의 효과 문구는 "구독 대신 API 키로 과금될 수 있다"이다.

셸의 GET 페이로드에 `engineEnv` 블록으로 싣고, 설정 화면의 엔진 요약 문장 아래에 목록으로 그린다. 아무것도 없으면 아무것도 그리지 않는다. 클라이언트가 스스로 환경을 읽지 않는다.

### 4.5 SDK를 올릴 때 확인하는 것

이 절이 사용자의 우려에 대한 절차적 답이다. SDK 버전을 올리는 커밋은 아래를 같이 한다.

1. `shell/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`의 CLI 버전을 이 스펙 §3에 적는다.
2. `npm run spike:subagent-model`을 실제 로그인으로 돌린다. 한 턴을 보내 `explorer`가 `claude-haiku-*`로 답했는지, 메인이 요청한 모델로 답했는지 확인한다. `CLAUDE_CODE_SUBAGENT_MODEL`을 걸고 한 번 더 돌려 naby가 적은 모델이 이기는지(현재 순서) 본다. 결과를 스파이크 머리말에 버전과 함께 적는다. `spike-subagent-gate`와 같은 방식이고 `spike:all`에는 넣지 않는다.
3. §3의 환경변수 목록을 바이너리 문자열 검색으로 다시 뽑아 `engineEnvironmentNotes`의 목록과 맞춘다.
4. 모델 카탈로그 캐시는 SDK 버전으로 이미 무효화된다. 손댈 것 없다.

## 5. 범위 밖

- `confluence-researcher`의 모델을 바꾸는 것. 심어진 행은 다시 쓰지 않는다(원칙 6).
- 서브에이전트 모델을 환경변수로 정하는 UI. naby는 그 변수를 읽지 않는다(원칙 1). 사용자가 셸 환경에 두면 4.4가 보여준다.
- 턴의 모델별 토큰을 따로 적는 것. `usage` 테이블은 턴당 한 행, 모델 하나라서 haiku 서브에이전트가 쓴 토큰이 메인 모델 값으로 합산된다. SDK result의 `modelUsage`에 모델별 값이 있으니 나눠 적을 수 있지만, 통계 화면이 행을 턴으로 세는지부터 확인해야 한다. 절약을 숫자로 보려면 필요한 다음 레버다. 구독 사용자는 상태 바의 5시간·7일 창이 실제 절약을 보여준다.
- 헤드리스 턴(텔레그램)의 위임 정책. 같은 `runTurn`을 타므로 dev-claude면 자동으로 적용된다. 따로 할 것이 없다.
- ai-sdk 엔진용 값싼 서브에이전트. 등급을 프로바이더별 모델로 옮기는 표와 도구 이름 두 철자(`Read`와 `read_file`)를 함께 선언해야 한다. `engines` 필드가 그 자리를 비워 둔다.
- `~/.claude/agents/*.md`의 네이티브 서브에이전트가 같은 이름으로 로드되는 경우. [harness-standalone](harness-standalone.md) §6이 아직 막지 못한 노출이고 이 스펙이 새로 만드는 문제가 아니다.

## 6. 구현 계획

| 마일스톤 | 무엇 | 파일 | 검증 |
|---|---|---|---|
| M1 런타임 | `explorer.md`·`implementer.md`(`engines: dev-claude`), 생성 스크립트 `SOURCES`와 `engines` 파싱, `generated.ts` 재생성, `core` 묶음과 `ALWAYS_ON_HARNESS_BUNDLES`, `subagent.engines`와 `subagentAllowedForEngine`, `DELEGATION_POLICY`·`delegationPolicyFor`와 `delegateSchema` 반영, `subagent_model` 이벤트와 활동 로그 종류, `engineEnvironmentNotes`, 라이브 스파이크 | `src/runtime/harness-assets/agents/*`, `scripts/gen-builtin-harness.mjs`, `src/runtime/harness-seed.ts`, `src/runtime/store/store.ts`, `src/runtime/delegation-policy.ts`, `src/runtime/delegate.ts`, `src/engines/claude-agent-sdk-engine.ts`, `src/runtime/engine.ts`, `src/runtime/session.ts`, `src/runtime/activity-log.ts`, `src/runtime/engine-env.ts`, `src/spikes/spike-subagent-model.ts`, `package.json` | `spike:harness-seed`(두 행 심김·모델·도구·engines·항상 켜짐·사용자 소유 유지), `spike:delegate`(정책 문장 조건), `spike:02`, `npm run typecheck` |
| M2 셸 서버 | 시드 호출부가 `ALWAYS_ON_HARNESS_BUNDLES`를 합쳐 넘김, `gatherSubagents`가 엔진으로 거름, `turnSystem` 정책 블록(변경 허용 여부 전달), `subagent_model` 전달, GET 페이로드 `engineEnv` | `engines/naby.ts`, `api/naby.ts` | `builtinHarness.test.ts`, 정책 블록·필터 소스 테스트, 기존 테스트 전부 |
| 스펙 개정 | [skill-hub-builtin](skill-hub-builtin.md) §2.7에 "프리셋 없는 항상 켜진 묶음" 추가(가산), [naby-activity-log](naby-activity-log.md) v0.1.1 | `specs/` | `/spec-guard` |
| M3 클라이언트 | `SubagentTask.model`, 리듀서, 블록 제목, 설정 화면 환경변수 목록, i18n | `subagentGroups.ts`, `applyStreamEvent.ts`, `SubagentBlock.tsx`, `NabyProviderSetup.tsx`, `locales/ko.json`·`en.json` | `subagentGroups.test.ts`, `applyStreamEvent.test.ts`, 설정 화면 배선 테스트, 셸 typecheck |

M1 → M2 → M3 순서다. M3는 이벤트 계약(4.3)만 알면 되므로 M1과 나란히 갈 수 있다.

## 7. 완료 기준

- 새 설치와 기존 설치 모두에서 부팅 뒤 하네스 목록에 `explorer`(haiku, Read·Glob·Grep)와 `implementer`(sonnet)가 켜진 채로 있다. 사용자가 끄면 다음 부팅에도 꺼져 있다.
- dev-claude 턴의 시스템 프롬프트에 위임 정책 문장이 있고, 두 서브에이전트를 모두 끄면 그 문장이 없다.
- 실제 로그인으로 "이 저장소에서 `effectiveAgentModel`이 쓰이는 자리를 전부 찾아줘"를 보내면 `explorer` 블록이 생기고 제목에 haiku가 보인다. 활동 로그에 `subagent_model` 행이 남는다.
- 셸 환경에 `CLAUDE_CODE_SUBAGENT_MODEL=opus`를 두고 앱을 띄우면 설정 화면에 그 변수와 효과가 보인다.
- 거기에 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`까지 두면 `explorer` 블록 제목이 haiku가 아니라 opus로 보인다. 원칙 2가 말하는 "조용하지 않은 덮어쓰기"다.
- 플랜 모드 턴에서는 시스템 프롬프트에 implementer 문장이 없고 explorer 문장만 있다.
- `explorer`를 지운 뒤 다시 부팅해도 돌아오지 않는다.
- `@explorer`로 직접 부르면 [phase-3-persona-agent](phase-3-persona-agent.md) §5의 우선순위대로 그 서브에이전트가 답하고 모델은 haiku다.
- ai-sdk 엔진을 고른 턴에는 두 서브에이전트가 목록에 없고 `naby_delegate` 설명에 정책 문장이 없다.
- `npm run spike:harness-seed`, `spike:delegate`, `spike:02`, `cd shell && npm test`, 양 트리 typecheck가 통과한다.

## 8. 검증 기록 (2026-09-14, v0.1.0 구현)

`npm run spike:subagent-model`을 실제 로그인으로 두 번 돌렸다. 번들 CLI 2.1.259, 메인 모델 `claude-opus-5[1m]`.

| 조건 | explorer가 답한 모델 | 읽는 법 |
|---|---|---|
| 환경변수 없음 | `claude-haiku-4-5-20251001` | 정의에 적은 `haiku`가 그대로 적용된다 |
| `CLAUDE_CODE_SUBAGENT_MODEL=opus` | `claude-haiku-4-5-20251001` | 정의의 `model`이 환경변수보다 앞선다. 2.1.251 이후의 순서다 |

`_FORCE=1`은 재지 않았다. 그 변수는 정의를 덮는 것이 문서화된 동작이고, 덮였을 때 블록 제목에 다른 모델이 보이는 것이 이 스펙의 답이다(원칙 2). SDK를 올릴 때 이 표에 행을 더한다(§4.5).

앱 경로로도 한 번 재현했다. prod 빌드 서버를 임시 DB와 `CLAUDE_CODE_SUBAGENT_MODEL=opus`로 띄우고 `model: 'sonnet'` 턴에 "explorer 서브에이전트로 `effectiveAgentModel` 호출 자리를 전부 찾아라"를 보냈다.

| 관측 | 값 |
|---|---|
| 새 DB의 하네스 목록 | `explorer` enabled · haiku · Read/Glob/Grep · dev-claude, `implementer` enabled · sonnet · dev-claude |
| GET 페이로드 `engineEnv` | `CLAUDE_CODE_SUBAGENT_MODEL=opus` 한 건, 효과 문구 포함 |
| `system/task_started` | `harness_task_agent: "explorer"` |
| `subagent_model` 이벤트 | `claude-haiku-4-5-20251001` |
| result `context_model` | `claude-sonnet-5` |
| 활동 로그 행 | `kind: subagent_model`, `agentType: "explorer"`, haiku |

explorer가 선언 밖의 도구를 부르려 하자 CLI가 스스로 거절한 호출이 셋 있었다("The user doesn't want to take this action right now"). naby 게이트의 거절이 아니라 `tools` 제한이 작동한 것이고, explorer는 정상 완료했다.

셸 테스트 200파일 3898개, 스파이크 `harness-seed` 66/66 · `delegate` 12/12 · `subagent-model-event` 11/11 · `02` 5/5 · `autonomy` 34/34, 양 트리 타입체크(이번 변경 파일 0건), prod 빌드 통과. 라이브로 보지 않은 것은 설정 화면과 블록 제목의 실제 렌더링, `_FORCE=1`, 플랜 모드의 정책 문장, ai-sdk 턴이다. 전부 단위 테스트와 스파이크로만 확인했다.

리뷰 뒤에 두 가지가 더 들어갔다. explorer 프롬프트의 코드펜스 중첩을 고쳤고(핵심 문단이 펜스 안에 갇혀 있었다), `@<서브에이전트>` 줄을 위임 지시로 바꿨다(4.2). 둘 다 라이브 실행 뒤의 변경이라 단위 테스트·스파이크·prod 빌드로만 확인했다.
