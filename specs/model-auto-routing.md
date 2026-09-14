---
id: model-auto-routing
type: design
version: 0.1.0
status: draft
scope: Claude 구독 엔진에서 모델을 `auto`로 두면 naby가 요청마다 haiku·sonnet·opus·fable 중 하나를 고르고, 고른 모델을 화면에 보여주는 것
related:
  - claude-multi-account
  - session-context-management
  - naby-voice-layer
  - phase-3-persona-agent
  - phase-3-fast-evolution
updated: 2026-09-14
---

# 모델 자동 선택 (auto)

## 1. 문제

모델 칩을 `default`로 두면 SDK 기본값이 되고, 이 기계에서 그 값은 `claude-opus-5[1m]`이다(`models.claude.cache`의 `resolvedModel`로 확인). 인사 한 줄도 opus가 답하고, 문체를 다듬는 나비 레이어 재작성과 리플렉션 판정도 opus로 돈다. 구독 한도는 모델별 창(`seven_day_opus`, `seven_day_sonnet`)으로 따로 잡히므로 가벼운 요청까지 opus로 보내면 정작 무거운 작업을 할 때 창이 비어 있다.

사용자가 원하는 것은 두 가지다. 요청의 무게에 맞는 모델을 naby가 골라 쓰고, 지금 어느 모델이 돌아가는지 화면에서 보이는 것이다. 매번 같은 모델이 뜨면 그것은 auto가 아니다.

## 2. 원칙

1. **명시 선택이 항상 이긴다.** 사용자가 칩에서 특정 모델을 고르면 라우터는 개입하지 않는다. `NABY_DEV_MODEL` 환경변수도 지금처럼 그 위에 있다. 라우팅 대상 에이전트와 서브에이전트가 가진 자기 모델도 그대로다.
2. **판정에 모델을 부르지 않는다.** 분류용 호출을 하나 더 만들면 아끼려던 비용을 도로 쓴다. 라우터는 순수 함수이고 입력은 이미 손에 있는 신호뿐이다.
3. **내리는 쪽을 좁게 잡는다.** 약한 모델이 어려운 일을 받으면 에러가 나지 않고 답만 나빠진다. 실패가 조용하므로 haiku로 내리는 조건은 좁고, 올리는 조건은 넓다.
4. **창에 안 들어가는 모델은 후보가 아니다.** opus는 1M, sonnet과 haiku는 200k다. 대화가 300k까지 찬 세션에서 sonnet을 고르면 그 턴은 실패한다. 창 크기는 비용 규칙이 아니라 자격 조건이다.
5. **고른 이유를 남긴다.** 무슨 모델을 왜 골랐는지 이벤트에 실어 보내고 화면에서 보여준다. 말없이 바뀌는 모델은 버그처럼 보인다.
6. **`''`(default)의 뜻은 바꾸지 않는다.** `''`는 지금처럼 "SDK 기본값"이다. `auto`는 새 값이고 SDK에는 절대 닿지 않는다. `auto`는 채팅 바의 선택값이지 에이전트의 모델 필드에 저장되는 값이 아니다.
7. **한도 규칙은 값이 있을 때만 움직인다.** 한도 퍼센트는 백엔드가 줄 때만 있고 대개 안 온다([claude-multi-account](claude-multi-account.md) §3.4). 값이 없으면 한도 규칙은 없는 것처럼 건너뛰고, 나머지 규칙은 그대로 돈다. 값이 있어야 켜지는 기능은 만들지 않는다는 그 문서의 원칙과 같다.

## 3. 확인한 사실

설계가 기대는 사실이다. 전부 이 저장소와 이 기계에서 확인했다.

- 엔진은 턴마다 새 `query()`를 만들고 세션을 resume하지 않는다. `buildQueryOptions`가 `input.model.model`을 그대로 SDK `model` 옵션에 넣는다(`src/engines/claude-agent-sdk-engine.ts:503`). 턴마다 다른 값을 넣어도 엔진은 바뀌지 않는다.
- 서버는 모델 값을 검증하지 않는다. `MODEL_SCOPES`는 스코프만 본다(`api/naby.ts:1996`). `auto`는 `ctx.params.model` → `requestedModel`(`engines/naby.ts:698`) → `modelForEngine`(`:791`) → SDK까지 그대로 흘러가 거기서 거절된다. 셸 엔진에서 가로채야 한다.
- `modelForEngine`은 사용자 턴당 한 번 정해지고 자율 루프의 모든 스텝이 같은 값을 쓴다(`:2202`). 라우팅은 자연히 턴 단위로 고정된다.
- `:792`부터 init 이벤트를 내보내는 `:1927` 사이에서 `modelForEngine`을 읽는 코드는 클로저뿐이다. 그 사이에 `turnText`(`:1245`), `routedAgent`/`routedStage`(`:921`/`:931`), `subjectGrowth`(`:1398`), `planMode`(`:1081`)가 전부 묶인다. 라우터를 부를 자리는 여기다.
- 클라이언트 칩은 요청한 값만 안다. init 이벤트의 `model`은 `modelLabel`이고 엔진이 실제로 돌리기 전에 나간다. 엔진 자체의 init(`kind:'init'`, 해석된 id)은 `:2347`에서 버려진다. 실제 돌아간 id는 result 이벤트의 `context_model`에만 있고, 화면에서는 컨텍스트 게이지 툴팁(`TokenUsageBar.tsx:457`)에만 나온다.
- 라이브 카탈로그(`models.claude.cache`)의 값은 `default` · `opus[1m]` · `claude-fable-5-1[1m]` · `sonnet` · `haiku`다. 별칭 `opus`·`sonnet`·`haiku`·`fable`도 SDK가 받는다.
- `contextWindowFor('dev-claude', 'opus[1m]')`는 이 작업 전에는 **undefined**였다. 별칭 판정이 맨 별칭만 정확히 비교해서 `[1m]`이 붙은 별칭은 어느 규칙에도 닿지 못했다. `isClaudeAlias()`가 꼬리의 `[...]`를 떼고 비교하도록 고쳤고(`src/runtime/context-window.ts`), 맨 별칭 200k와 `default` undefined는 그대로다. 스파이크가 세 사실을 고정한다.
- 구독 한도는 `usage.limits.cache.<accountId>` 설정 키에 캐시된다. `readUsageCache`·`usageCacheState`가 `api/naby.ts:1073`·`:1125`에 있고 동기 호출이다. 다만 `engines/naby.ts`가 `api/naby.ts`를 가져오는 방향은 없으므로 두 함수를 `server/lib/`로 옮긴다.
- 컨텍스트 점유량은 세션에 저장되지 않는다. `usage` 테이블의 `input_tokens`는 턴의 합계이지 점유량이 아니다. 턴 시작 시점에는 `store.getMessages(sessionId)`로 대화 기록을 읽어 추정하는 수밖에 없다.
- 텔레그램 턴(`lib/telegramChat.ts:686`)은 `model`을 넘기지 않는다. 그 경로는 지금도 SDK 기본값이고 이 스펙 뒤에도 그렇다.
- 리플렉션 판정·나비 레이어 재작성·인계 요약은 `resolveJudgeBackend`가 `{ providerId: 'dev-claude' }`만 넘긴다(`lib/reflection.ts:1098`). 모델 필드 하나로 바꿀 수 있다.

## 4. 설계

### 4.1 새 값 `auto`

모델 칩의 Claude 스코프에 `auto` 행을 넣는다. 큐레이션 목록(`CLAUDE_MODELS`)의 맨 앞에 두고, 라이브 목록이 오면 `claudeOptionsFrom`이 앞에 붙인다. 라이브 목록은 큐레이션 목록을 통째로 대체하므로 두 곳 다 필요하다. 라벨은 "Auto", 힌트는 "naby가 요청마다 고른다"이다.

저장은 지금 방식 그대로 `model.selected:dev-claude`에 `auto`가 들어간다. 턴 요청의 `model` 필드로 `auto`가 서버에 닿는다.

이 행은 채팅 바 칩에만 있다. 카탈로그를 쓰는 다른 자리가 생기면 에이전트용 목록(`CLAUDE_MODELS_FOR_AGENTS`)에서 가져온다. 다만 에이전트 편집기의 모델란은 목록이 아니라 자유 입력이라 사람이 `auto`를 적을 수 있고, 서버는 모델 값을 검증하지 않는다. 그래서 막는 자리는 서버다. 에이전트와 서브에이전트의 `model`이 `auto`면 빈 값과 같이 "턴의 모델을 물려받는다"로 읽는다(4.5).

### 4.2 라우터

`src/runtime/model-router.ts`에 순수 함수로 둔다. 입력과 출력은 이렇다.

```ts
type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable';

type RouteSignals = {
  text: string;                 // 이번 턴의 사용자 말 (turnText)
  fullMode: boolean;            // @naby 전면 모드
  stage?: GrowthStage;          // 응답 주체의 성장 단계
  planMode: boolean;            // 플랜 모드(읽기 전용)
  estimatedContextTokens: number;   // 대화 기록으로 추정한 점유량
  previousTier?: ModelTier;     // 이 세션에서 마지막으로 답한 모델의 등급
  windows: Record<ModelTier, number | undefined>;  // 등급별 창 크기
  usage?: { fiveHourPct?: number; opusPct?: number };  // 둘 다 없을 수 있다
};

type RouteDecision = { tier: ModelTier; reason: RouteReason };
type RouteReason =
  | 'plan-mode' | 'design-ask' | 'build-ask' | 'full-mode'
  | 'chat' | 'default' | 'sticky' | 'window-fit' | 'budget-cap';
```

등급에는 순서가 있다. **haiku < sonnet < opus < fable**이다. "낮다", "가깝다"는 전부 이 순서로 잰다. 창 크기만은 순서와 별개로 각 등급의 실제 창을 본다.

판정 순서다. 앞 규칙이 정한 등급을 뒤 규칙이 깎거나 올린다.

1. **바탕 등급.** 요청의 성격으로 한 등급을 고른다.
   - `planMode`이면 **fable**. 사용자가 "먼저 계획, 편집 안 함"을 켠 턴은 설계·검토 턴이다. (`plan-mode`)
   - 텍스트에 설계·스펙·아키텍처·계획서·전략·리뷰·검토 계열 동사가 있고 코드 편집 동사가 없으면 **fable**. (`design-ask`)
   - 구현·수정·고쳐·리팩터·버그·테스트·만들어·implement·fix·refactor·debug·build·test 계열 동사가 있거나, 코드 펜스가 있거나, 파일 경로가 둘 이상이거나, 본문이 1,200자를 넘으면 **opus**. (`build-ask`) "how should we build the architecture"처럼 설계 질문에 build가 섞이면 opus로 간다. 위로 가는 오답이라 감수한다.
   - `fullMode`이고 단계가 번데기 이상이면 **opus**. 나비가 도구를 여러 스텝 주도하는 턴이다. (`full-mode`)
   - 본문이 200자 이하이고 코드·경로·URL이 없고 위 동사가 하나도 없으면 **haiku**. (`chat`)
   - 그 밖에는 **sonnet**. (`default`)
2. **붙어 있기.** `previousTier`가 있고 `estimatedContextTokens`가 40k를 넘으면 바탕 등급이 그보다 낮아도 `previousTier`를 유지한다. 턴마다 새 `query()`가 전체 기록을 다시 보내고 프롬프트 캐시는 모델별이므로, 큰 대화에서 모델을 오가면 캐시를 버리고 5시간 창을 더 빨리 쓴다. 작은 대화에서는 매 턴 달라지고 깊은 대화에서는 붙어 있는다. (`sticky`)
3. **창 자격.** 고른 등급의 창이 `estimatedContextTokens × 1.5 + 20k`보다 작으면 창이 맞는 등급 가운데 순서상 가장 가까운 것으로 바꾼다. 거리가 같으면 높은 쪽이다. 어느 등급도 안 맞으면 창이 가장 큰 등급이다. 추정이 실제보다 작을 수 있으니 여유를 크게 둔다. (`window-fit`)
4. **한도 보호.** `usage`의 값이 있을 때만 본다(원칙 7). `opusPct ≥ 90` 또는 `fiveHourPct ≥ 90`이면 opus와 fable을 sonnet으로 내린다. 단 sonnet이 3번 창 자격에 걸리면 내리지 않는다. 창에 안 들어가는 모델로 내려 실패시키는 것보다 한도를 조금 더 쓰는 쪽이 낫다. (`budget-cap`)

키워드 목록은 상수로 두고 한국어·영어를 함께 둔다. 한국어는 조사가 붙어 오므로("설계해줘") 소문자 포함 검사다. 영어는 단어 경계로 비교한다. "explain"이 "plan"에, "specific"이 "spec"에 걸려 가장 비싼 모델로 가는 일이 있어서다. 영어 굴절형(plans, planning, fixes, testing 같은 것)은 목록에 직접 적는다. 코드 펜스 안의 텍스트는 키워드 검사에서 뺀다. 오답을 줄이려고 목록을 키우지 않는다. 애매하면 sonnet이다.

### 4.3 등급을 카탈로그 값으로

같은 파일에 `pickCatalogValue(tier, liveModels)`를 둔다. 라이브 카탈로그가 있으면 그 안에서 고른다.

| 등급 | 우선 | 없으면 |
|---|---|---|
| opus | `opus[1m]` | `opus[1m]` |
| fable | `value`가 `claude-fable`로 시작하는 행 | `fable` |
| sonnet | `sonnet` | `sonnet` |
| haiku | `haiku` | `haiku` |

opus를 `opus[1m]`으로 두는 이유는 오늘의 `default`가 그 값으로 풀리기 때문이다. auto를 켰다고 창이 1M에서 200k로 줄면 안 된다. 카탈로그가 없을 때도 같은 값을 쓴다. 이 플랜이 `default`로 이미 그 모델을 받고 있으므로 `opus[1m]`은 지어낸 값이 아니다.

등급별 창 크기(`windows`)는 이 값에 `contextWindowFor('dev-claude', value)`를 물어 채운다. 라우터가 카탈로그를 직접 알지 않게 하려는 분리다. 한 가지 결과를 알고 둔다. 맨 별칭 `fable`은 그 함수가 200k로 답한다(`claude-fable*` 형태의 id만 1M). 카탈로그 캐시가 없는 기계에서 큰 세션의 플랜 모드 턴은 창 자격 규칙이 fable을 opus로 옮긴다. 모르는 창을 1M로 가정하는 것보다 이쪽이 정직하다.

### 4.4 점유량 추정과 이전 등급

- 점유량: `store.getMessages(sessionId)`를 `src/runtime/compaction.ts`의 `estimateTokens`에 넣고 시스템 프롬프트 몫 8k를 더한다. 글자 수를 토큰으로 바꾸는 규칙은 [session-context-management](session-context-management.md) §2.3이 이미 갖고 있으므로 사본을 만들지 않는다. 정확한 값이 아니고 창 자격 판단에 쓰는 하한이다. 그래서 4.2의 3번이 여유를 1.5배로 잡는다. 기록 전체를 매 턴 읽는 것은 `runTurn`이 프롬프트를 만들 때 읽는 것과 같은 데이터이지만 같은 읽기는 아니다. SQLite 조회와 JSON 파싱이 한 번 더 든다. 250k 세션에서 무시할 크기는 아니지만 모델 호출 하나에 비하면 작다.
- 이전 등급: `store.listUsage(sessionId)`의 마지막 dev-claude 행의 `model`(해석된 id)을 `tierOfModelId`로 등급으로 바꾼다. `claude-opus-*` → opus, `claude-fable-*` → fable, `claude-sonnet-*` → sonnet, `claude-haiku-*` → haiku. 못 읽으면 undefined다.

두 함수 모두 순수 함수로 `src/runtime/model-router.ts`에 두고 스파이크로 검증한다.

### 4.5 셸에서 가로채는 자리

`engines/naby.ts`의 dev-claude 분기(`:791`)에서 `requestedModel === 'auto'`이고 `selection.model`이 없으면 `autoRequested = true`로 표시하고 `modelForEngine`은 비워 둔다. `turnText`·`routedStage`·`subjectGrowth`·`planMode`가 묶인 뒤, init 이벤트 직전에 `server/lib/modelRoute.ts`의 `resolveAutoModel(...)`을 부른다. 이 함수가 신호를 모으고(4.4의 추정, 한도 캐시 읽기, 카탈로그 캐시 읽기) 런타임 라우터를 호출해 `{ value, tier, reason }`을 돌려준다.

- `modelForEngine = value`, `modelLabel = value`. init의 `model` 필드는 기능적인 값이어야 한다. `contextWindowFor`가 이 문자열로 창을 잰다.
- init 이벤트에 `model_route: { requested: 'auto', tier, reason }`을 따로 싣는다.
- 라우팅 대상 에이전트(`routedAgent.model`)에 실제 모델이 있으면 라우터를 부르지 않는다. 그 모델이 `modelForEngine`이자 `modelLabel`이 되고 `model_route`는 싣지 않는다. init 이벤트는 실제로 도는 모델만 말해야 한다. 그 값이 `auto`이면 빈 값으로 보고 라우터를 돌린다. 서브에이전트를 엔진 입력으로 옮기는 자리와 중첩 턴도 같은 규칙을 탄다. 판정은 `effectiveAgentModel()` 한 함수가 하고 네 자리(서브에이전트 목록, 중첩 턴, 라우팅 에이전트 고정, `runTurn` 모델 선택)가 모두 그 함수를 거친다. 테스트가 자리 수를 세므로 다섯 번째가 생기면 테스트가 먼저 안다.
- 카탈로그 캐시(`models.claude.cache`)는 TTL을 보지 않고 읽는다. TTL은 "새 모델이 나왔을지 모르니 다시 물어볼 때"의 기준이지 있는 행을 못 믿을 이유가 아니다. 만료됐다고 행을 버리면 fable이 맨 별칭으로 떨어져 창이 200k로 줄어든다.
- 한도 캐시는 `usage.limits.cache.<accountId ?? 'default'>` 키를 읽는다. `accountId`는 턴 시작에 한 번 읽은 값을 그대로 쓴다. 턴 중간에 계정이 바뀌어도 이 턴은 시작 계정으로 돈다는 [claude-multi-account](claude-multi-account.md) §5.4의 규칙과 같다. `usageCacheState`가 `fresh`나 `stale-usable`일 때만 쓴다. 없으면 `usage`를 넘기지 않고, 라우터는 한도 규칙을 건너뛴다.
- 라우터가 예외를 던지면 잡아서 sonnet으로 가고 경고 로그를 남긴다. 자동 선택의 실패가 턴의 실패가 되면 안 된다.
- 로그 한 줄: `[engine:naby] auto → sonnet (chat) as sonnet`. 꼬리는 실제로 SDK에 넘긴 카탈로그 값이다.

`preflightEngine`(`:555`)은 dev-claude에서 `requestedModel`을 보지 않으므로 손대지 않는다.

### 4.6 이벤트 계약

셸이 클라이언트로 내보내는 SDK 모양 이벤트에 두 가지가 더해진다. 런타임의 `EngineEvent`는 바뀌지 않는다.

| 이벤트 | 필드 | 타입 | 언제 |
|---|---|---|---|
| `system/init` | `model` | string | 기존 필드. auto 턴에는 라우터가 고른 카탈로그 값이 들어간다. 기능적인 값이어야 한다. |
| `system/init` | `model_route` | `{ requested: 'auto'; tier: ModelTier; reason: RouteReason }` | 요청 모델이 `auto`인 턴에만 있다. 명시 선택 턴에는 없다. |
| `result` | `context_model` | string | 기존 필드. 실제로 답한 모델의 id. 클라이언트는 이것을 `served`로 이어 붙인다. |

컨텍스트 게이지의 분모 규칙은 그대로다. 실행이 보고한 창이 먼저고 init의 `model`은 폴백이다([session-context-management](session-context-management.md) §2.1).

### 4.7 표시

보여주는 자리는 **모델 칩 하나**다. 컨텍스트 게이지 툴팁에 있는 실제 id는 그대로 둔다.

- `Chat.tsx`가 init 이벤트의 `model_route`를 상태로 들고 `ModelSwitcher`에 `liveRoute` prop으로 넘긴다. 세션이 바뀌거나 사용자가 auto 아닌 값을 고르면 비운다.
- 칩의 값이 `auto`이고 `liveRoute`가 있으면 라벨을 "Auto · Sonnet"처럼 쓴다. 등급 표시명은 라이브 카탈로그의 `displayName`을 쓰고 없으면 등급 이름의 첫 글자를 대문자로 쓴다.
- 칩 툴팁에 이유를 한 줄로 쓴다. 이유 코드별 문구는 i18n 키 `modelSwitcher.route.<reason>`이다.
  - `plan-mode` "플랜 모드라 설계용 모델" / `design-ask` "설계·검토 요청" / `build-ask` "구현·수정 요청" / `full-mode` "나비 전면 모드" / `chat` "짧은 대화" / `default` "일반 요청" / `sticky` "대화가 커서 이전 모델 유지" / `window-fit` "대화가 커서 큰 창의 모델" / `budget-cap` "한도가 차서 한 단계 낮춤"
- result 이벤트의 `context_model`이 도착하면 같은 상태에 `served`로 덧붙이고 툴팁에 실제 id를 함께 보인다. 칩 라벨은 등급 이름을 유지한다.

## 5. 범위 밖

- **보조 호출(리플렉션 판정·나비 레이어 재작성·인계 요약)의 모델을 낮추는 것.** `resolveJudgeBackend`의 dev-claude 분기(`lib/reflection.ts:1098`)에 모델 필드 하나만 넣으면 되지만, 이 스펙에 넣지 않는다. 그 분기는 [phase-3-continuous-learning](phase-3-continuous-learning.md) §4.8과 [naby-voice-layer](naby-voice-layer.md) §10이 소유하고, 두 문서의 검증(§4.4, §9)은 모의 판정기라 모델을 바꿔도 아무것도 검출하지 못한다. 재작성 검증 밴드(voice-layer §6.1)도 opus로 맞춘 값이다. 낮추려면 실제 판정 분포를 비교하는 실측이 먼저다. 그 결정은 두 문서의 가산 개정으로 닫는다.

- 턴 중간에 모델을 올리는 것. 스텝마다 모델을 바꾸려면 `runTurn` 구조를 고쳐야 하고 지금은 이유가 약하다.
- 텔레그램·예약 작업 같은 헤드리스 턴에 auto를 적용하는 것. 그 경로는 `model`을 넘기지 않으며 지금처럼 SDK 기본값이다.
- `effort` 옵션. SDK 0.3.259가 `effort`를 받고 카탈로그도 `supportsEffort`를 돌려주지만 이 스펙은 모델 등급만 다룬다. 다음 레버로 남긴다.
- 점유량을 세션에 저장하는 것. 추정으로 충분하면 컬럼을 늘리지 않는다.

## 6. 구현 계획

| 마일스톤 | 무엇 | 파일 | 검증 |
|---|---|---|---|
| M1 런타임 라우터 | `ModelTier`·`routeModelTier`·`pickCatalogValue`·`tierOfModelId`·`estimateContextTokens` | `src/runtime/model-router.ts`, `src/spikes/spike-model-router.ts`, `package.json`(`spike:model-router`) | 스파이크 통과, `npm run typecheck` |
| M2 셸 서버 | 한도 캐시 함수를 `server/lib/usageCache.ts`로 옮김, `server/lib/modelRoute.ts`(`resolveAutoModel`), `engines/naby.ts` 가로채기와 `model_route` 필드 | `api/naby.ts`(import 경로만), `lib/usageCache.ts`, `lib/modelRoute.ts`, `engines/naby.ts` | `modelRoute.test.ts`(순수 함수), `nabyAutoModel.test.ts`(소스 텍스트로 호출 위치가 init 이전인지), 기존 테스트 전부, `npm run spike:02` |
| M3 클라이언트 | `auto` 행, `liveRoute` 상태와 prop, 칩 라벨·툴팁, i18n ko/en, 에이전트 편집기에서 `auto` 제외 | `modelCatalog.ts`, `ModelSwitcher.tsx`, `Chat.tsx`, `useChatStream.ts`, `types.ts`, `locales/ko.json`·`en.json` | `modelCatalog.test.ts`에 auto 행, `modelRouteLabel.test.ts`, `cd shell && npm test`, 셸 typecheck |

순서는 M1 → M2 → M3다. M3는 서버 이벤트 계약(4.6)만 알면 되므로 M1과 나란히 진행할 수 있다.

테스트는 4.2의 규칙과 하나씩 짝을 맞춘다. 스파이크가 규칙 1의 여섯 갈래와 규칙 2·3·4를 각각 한 케이스 이상 갖고, `modelRoute.test.ts`는 신호 수집(추정·이전 등급·캐시 상태·카탈로그 부재)을 갖고, `nabyAutoModel.test.ts`는 호출 위치와 `routedAgent.model === 'auto'` 무시를 갖는다.

## 7. 완료 기준

- 칩에서 Auto를 고르고 "안녕"을 보내면 칩이 "Auto · Haiku"로 바뀌고, 이어서 긴 구현 요청을 보내면 "Auto · Opus"로 바뀐다. 두 턴 사이에 앱을 다시 켜지 않는다.
- 플랜 모드를 켜고 보내면 "Auto · Fable"이다.
- 대화 기록이 200k 창을 넘긴 세션에서는 짧은 인사도 opus로 간다. 툴팁이 "대화가 커서 큰 창의 모델"이라고 말한다.
- 대화 기록 추정이 40k를 넘긴 세션에서 직전 턴이 opus였으면 짧은 인사도 opus로 가고 툴팁이 "대화가 커서 이전 모델 유지"라고 말한다.
- 카탈로그 캐시를 지운 상태에서도 auto 턴이 실패하지 않고 별칭 값으로 간다.
- 한도 캐시에 `opusPct: 95`를 넣으면 구현 요청이 sonnet으로 가고, 캐시가 만료(`expired`) 상태면 같은 요청이 opus로 간다.
- `@에이전트`로 부른 턴에서 그 에이전트의 모델이 있으면 auto와 무관하게 그 모델이 간다. 그 값이 `auto`면 라우터 결과가 간다.
- 칩을 Opus로 고정하면 어떤 요청에도 라우터가 개입하지 않는다.
- `NABY_DEV_MODEL`을 두면 auto를 골라도 그 값이 간다.
- 에이전트의 모델란에 `auto`를 적어 저장해도 그 에이전트를 부른 턴이 실패하지 않고 턴의 모델로 돈다.
- `cd shell && npm test`, 양 트리 `npm run typecheck`, `npm run spike:model-router`, `npm run spike:02`가 통과한다.

## 8. 검증 기록 (2026-09-14, v0.1.0 구현)

| 항목 | 결과 |
|---|---|
| `npm run spike:model-router` | 65/65 통과 |
| `cd shell && npx vitest run` | 197 파일 · 3849 테스트 통과 (새 테스트 40개) |
| `npm run spike:02` · `spike:autonomy` · `spike:compaction` | 5/5 · 34/34 · 10/10 통과 |
| 루트 `npm run typecheck` | `src/`·`electron/` 0건. `shell/**` 30건은 이번 변경과 무관한 파일(git status에 없음) |
| prod 서버 실 턴 (`model: 'auto'`, "안녕", 임시 DB) | init `model: "haiku"`, `model_route: {tier: haiku, reason: chat}`, result `context_model: "claude-haiku-4-5-20251001"`, 로그 `auto → haiku (chat) as haiku` |

실 엔진에서 돌린 경로는 haiku/chat 하나다. opus 승급·플랜 모드 fable·창 자격·붙어 있기·한도 보호·에이전트 모델 우선은 스파이크와 단위 테스트로만 확인했다. 칩의 "Auto · Haiku" 표시는 순수 함수 테스트로 확인했고 화면에서 눈으로 보지는 않았다.
