---
id: agent-import-adapters
title: 참가자 가져오기 어댑터 — 외부 에이전트 정의를 참가자 명세로 바꾼다
type: interface
version: 0.2.0
status: review
scope: 외부 포맷의 에이전트 정의(Claude Code 서브에이전트 .md, naby 사이드카 v1/v2, 캐릭터 카드 V2/V3)를 multi-agent-chat R1.1의 참가자 명세로 정규화하는 어댑터 인터페이스, 포맷별 필드 매핑, 손실 보고, 안전 검사 파이프라인, 사이드카 v2 내보내기. 어떤 참가자가 세션에서 어떻게 말하는지는 multi-agent-chat이, 나비(persona)·custom 사이드카의 기존 규칙은 phase-3-agent-export가 맡는다.
related: [multi-agent-chat, phase-3-agent-export, harness-portability-strategy]
updated: 2026-10-16
---

# 참가자 가져오기 어댑터

> 이 문서가 답하는 질문 — **"다른 도구에서 만든 에이전트 정의를 naby 참가자로 들이려면 무엇을 어떻게 옮기고, 못 옮기는 것은 어떻게 알리며, 파일이 무엇을 주장하지 못하게 하는가?"**
>
> 상태: 설계(2026-10-16). [multi-agent-chat](multi-agent-chat.md) R4·D11의 설계이고 마일스톤 MAC-M4다. 구현은 Opus 에이전트가 한다.

## 1. 원칙

1. **정규화 + 원본 보관.** 옮길 수 있는 필드는 참가자 명세로 옮기고, 원본 전체와 모르는 필드는 `profile.extensions[format]`에 그대로 둔다. 캐릭터 카드 스펙은 모르는 `extensions`를 지우지 말라고 한다. M365 매니페스트는 모르는 속성이 있으면 문서가 무효가 된다. 두 경우 모두 모르는 필드를 버리지 않고 `extensions`에 보관하면 된다.
2. **손실은 보고한다.** 코드 참조, 벤더 고유 도구 이름, 테넌트 종속 ID, 비밀값처럼 옮길 수 없는 것은 개수와 이름을 미리보기에 보여준다. 조용히 빠지면 사용자는 다 들어왔다고 믿는다(agent-export §2와 같은 이유).
3. **파일은 아무것도 주장하지 못한다.** `id`·`kind`·단계·신뢰·도구 권한은 파일이 아니라 가져오기 경로와 사용자가 정한다. agent-export §7.3의 규칙을 그대로 물려받는다.
4. **어댑터는 순수 함수다.** 바이트를 받아 가져오기 계획(`ImportPlan`)을 돌려주고 스토어를 만지지 않는다. 적용은 셸 액션이 두 번째 요청에서 한다(두 단계, agent-export §7.4).
5. **런타임에 둔다.** 어댑터와 안전 검사는 `src/runtime/import/`에 있다. 프로바이더·UI와 무관하고 스파이크로 검증한다.

## 2. 인터페이스

```ts
// src/runtime/import/types.ts
export type ImportFormat =
  | 'claude-agent-md' | 'naby-sidecar' | 'character-card-v2' | 'character-card-v3'
  | 'm365-declarative-agent' | 'crewai-agents-yaml' | 'dify-dsl' | 'letta-af';   // 뒤 넷은 후속

export type ImportInput = { fileName: string; bytes: Uint8Array; now: number; existingNames: readonly string[] };

export type ImportLoss = {
  field: string;                               // 원본 필드 경로, 예: 'data.extensions.chub'
  action: 'kept-in-extensions' | 'merged' | 'dropped' | 'defaulted';
  into?: string;                               // 'profile.guardrails.policy' 같은 목적지
  note: string;                                // 사용자에게 보이는 한 줄(영문 키 → i18n)
};

export type ImportPlan = {
  format: ImportFormat;
  agent: AgentInput & { kind: 'participant'; profile: ParticipantProfile };
  losses: ImportLoss[];
  warnings: string[];                          // 시크릿 의심, 이름 변경 등
  report: { renamedFrom?: string; sourceHash: string; secretsRedacted: number };
};

export type ImportResult = { ok: true; plan: ImportPlan } | { ok: false; problems: string[] };

export interface ParticipantAdapter {
  readonly format: ImportFormat;
  detect(input: { fileName: string; bytes: Uint8Array }): number;   // 0~1 확신도. 확장자·매직·필드로 판정
  parse(input: ImportInput): ImportResult;
}
```

- `src/runtime/import/index.ts`의 `importParticipant(input, { format?: ImportFormat }): ImportResult`가 진입점이다. `format`이 없으면 `detect` 최고점 어댑터를 쓰고 0.5 미만이면 `problems:['unrecognized format']`이다.
- 모든 어댑터는 `parse` 끝에서 **공통 파이프라인** `finalizePlan(draft, input)`을 거친다(§4). 어댑터는 매핑만 하고 안전 검사 코드는 넣지 않는다.

## 3. 포맷별 매핑

목적지 필드는 multi-agent-chat §8.1의 `Agent`(기존 컬럼)와 `ParticipantProfile`이다.

### 3.1 Claude Code 서브에이전트 `.md` (`claude-agent-md`)

기존 파서 `parseSubagentArtifact(fallbackName, raw)`(`shell/.../harnessImporter.ts:382`)는 셸에 있고 `harness_items`용이다. 어댑터는 그 frontmatter 규칙을 **런타임에 다시 구현**하지 않고, 파서를 `src/runtime/import/claudeAgentMd.ts`로 옮겨 셸이 거기서 import하게 한다(한 사본).

| 원본 | 목적지 | 비고 |
|---|---|---|
| `name` | `name`, `profile.displayName` | 공백은 `-`로 |
| `description` | `description` | 위임 판단 문장으로 그대로 쓴다 |
| 본문 | `systemPrompt` | |
| `model` | `model` | `inherit`·빈값은 비움 |
| `tools` / `allowed-tools` / `allowedTools` | `toolRefs` | naby 도구·MCP 이름과 맞는 것만 남기고 나머지는 `dropped` 손실(`Read`·`Bash` 같은 Claude Code 내장 이름) |
| `skills` | `profile.skills` | 설치된 스킬 이름과 맞는 것만, 나머지 `dropped` |
| `mcpServers` | `profile.mcpServers` | 등록된 서버 이름과 맞는 것만 |
| `color` | `profile.color` | Claude 색 이름 → hex 표 |
| `permissionMode` | `profile.guardrails.permissionMode` | `plan`만 인정, 나머지 `defaulted` |
| `memory`, `hooks`, `maxTurns`, `effort`, `isolation`, `background`, `initialPrompt`, 그 외 | `extensions['claude-agent-md']` | `kept-in-extensions` |

아바타는 기본 이모지(🤖)이고 `defaulted` 손실로 적는다.

### 3.2 naby 사이드카 (`naby-sidecar`, v1·v2)

- **v2**(이 문서가 정의, §5)는 `agent.profile`을 그대로 읽는다. `kind`·`id`·단계는 여전히 읽지 않는다.
- **v1**(agent-export §1)은 `agent.{name, description, systemPrompt, model, toolRefs, memoryScope}`를 읽고 `profile`은 기본값이다. `memories`·`ledger`·`growthAtExport`는 참가자에게 뜻이 없으므로 **`dropped` 손실로 보고**하고 버린다(참가자는 성장하지 않는다). 그 파일을 custom 에이전트로 가져오고 싶으면 기존 `agent.import` 경로를 쓴다 — 미리보기에 그 안내를 보인다.
- `formatVersion > 2`는 거부(`problems`).

### 3.3 캐릭터 카드 V2 / V3 (`character-card-v2`, `-v3`)

입력은 JSON, 또는 PNG(`tEXt` 청크 `chara`(V2, base64 JSON) / `ccv3`(V3)). CHARX(zip)는 후속이다. `detect`: JSON에 `spec:'chara_card_v2'|'chara_card_v3'`, PNG는 청크 키워드.

| 원본(`data.*`) | 목적지 | 비고 |
|---|---|---|
| `name` | `profile.displayName`; `name`은 소문자·하이픈 핸들로 변환 | 한글 이름이면 핸들은 로마자화하지 않고 그대로(공백만 `-`) |
| `creator_notes` | `description` | 비어 있으면 `description`+`personality` 첫 문장으로 만들고 `merged` 표시. 미리보기에서 사용자가 고칠 수 있다 |
| `system_prompt` + `description` + `personality` + `scenario` | `systemPrompt` | 순서대로 절을 나눠 합친다(`merged`). `{{char}}`→이름, `{{user}}`→"사용자"로 치환 |
| `first_mes` | `profile.greeting` | |
| `alternate_greetings[]` | 첫 항목은 `greeting`이 비었을 때만, 나머지 `extensions` | `kept-in-extensions` |
| `mes_example` | `profile.examples` | `<START>` 구분, `{{user}}:`/`{{char}}:` 쌍을 최대 5개 |
| `post_history_instructions` | `profile.guardrails.policy` | `merged`. 가드레일 자연어 정책으로 |
| `character_book.entries[]` | `profile.knowledge[]` (`inject:'on-demand'`, `keywords: keys`, `source.inline: content`) | `constant:true`면 `inject:'always'`. `enabled:false`는 `dropped`. 20개 초과는 `dropped` |
| `tags`, `creator`, `character_version`, `extensions`, V3 `assets`(icon 외), `nickname`, `creator_notes_multilingual`, `group_only_greetings`, 로어북의 `use_regex`·데코레이터 | `extensions['character-card-vN']` | `kept-in-extensions`. 정규식 로어북은 키워드로 쓰지 않고 보관만 |
| V3 `assets[type='icon']` 또는 PNG 자체 | `profile.avatar` | 이미지는 64 KB 이하로 축소한 data URL, 넘으면 이모지 기본값으로 대체 + `defaulted` |
| 도구·MCP·모델 | 없음 → `toolRefs: []`, `mcpServers: []`, `model` 비움 | `defaulted` |

### 3.4 후속 포맷 (요약, 구현하지 않음)

| 포맷 | 핵심 매핑 | 손실이 큰 곳 |
|---|---|---|
| M365 선언형 에이전트 | `name`·`description`·`instructions`·`conversation_starters[0]→greeting`·`disclaimer→guardrails.policy` | `capabilities`(테넌트 종속), `actions`(OpenAPI 동반 필요) |
| CrewAI `agents.yaml` | `role`+`goal`+`backstory`→`systemPrompt`(절 구분), `llm→model`, `knowledge_sources→knowledge` | `tools`(코드 참조), `guardrail`(콜백) |
| Dify DSL(`agent-chat`) | `app.name/description/icon`, `model_config.pre_prompt→systemPrompt`, 모델 | 지식베이스(데이터 없음), 도구 API 키 |
| Letta `.af` | `system→systemPrompt`, `core_memory`의 persona 블록→`systemPrompt` 절, `llm_config→model` | `messages` 이력, 도구 소스코드, `tool_rules` |

## 4. 공통 파이프라인 `finalizePlan`

순서가 곧 규칙이다.

1. **이름**: `freeAgentName(wanted, existingNames)`(`agent-import.ts`)로 충돌 시 `-imported`, `-imported-2`. 바뀌면 `report.renamedFrom`.
2. **시크릿**: `looksLikeSecret`을 `systemPrompt`·`guardrails.policy`·`greeting`·`examples`·`knowledge.inline`에 돌린다. 걸린 값은 `[redacted: looked like a credential]`로 바꾸고 `secretsRedacted`를 센다. `systemPrompt`가 통째로 의심되면 가리지 않고 `warnings`에 넣는다(agent-export §2의 "지시문은 가리지 않고 알린다").
3. **권한 최소화**: `toolRefs`는 어댑터가 준 값 중 **현재 설치된 도구·MCP 이름과 맞는 것만** 남기고, 나머지는 `dropped`. 맞는 것이 없으면 `[]`. `mcpServers`·`skills`도 같다. 파일에 적힌 도구가 설치돼 있지 않으면 쓸 수 없다.
4. **크기 상한**: `knowledge` 20개·inline 16 KB·`examples` 5개·아바타 64 KB·`systemPrompt` 32 KB. 넘는 부분은 `dropped`.
5. **파일이 정한 값 무시**: `id`·`kind`·`stage`·`trusted`·`autonomy` 같은 키가 어디에 있어도 읽지 않는다. 읽는 코드가 없다(테스트가 그 사실을 고정한다).
6. **출처**: `profile.origin = { format, importedAt: now, sourceHash: sha256(bytes), sourceName: fileName }`. `extensions[format]`에 원본을 넣는다. PNG는 청크 JSON만, 이미지 바이트는 넣지 않는다.
7. **profile 검증**: `parseParticipantProfile`(multi-agent-chat §8.1)이 최종 검증한다. 실패하면 `problems`.

## 5. 내보내기 — 사이드카 v2

`AGENT_EXPORT_FORMAT_VERSION`(=1)은 **그대로 둔다.** 나비·custom의 사이드카는 v1이다. 참가자 내보내기(`participant.export`)만 새 상수 `PARTICIPANT_EXPORT_FORMAT_VERSION = 2`를 쓴다. 상수가 하나뿐이면 2로 올리는 순간 나비·custom 내보내기까지 v2가 되어 구버전 naby가 전부 거부하기 때문이다. `.md`는 그대로(Claude Code 서브에이전트 표준 형식)이고 사이드카에 `agent.profile`이 생긴다.

```ts
{ formatVersion: 2, source: 'naby', exportedAt,
  agent: { name, description?, systemPrompt, model?, toolRefs?, memoryScope, autonomy,
           profile?: ParticipantProfile },          // participant일 때만. origin·extensions 포함
  origin: { agentId, kind, createdAt },
  memories, ledger, growthAtExport }                 // participant는 memories=[] · ledger=[] · growthAtExport 생략
```

- 참가자 임포터(§3.2)는 v1·v2를 모두 읽는다. 기존 `agent.import`(custom 경로, `parseAgentSidecar`)는 그대로 `formatVersion > 1`을 거부하고, 거부 메시지에 "참가자 파일이면 참가자 가져오기를 쓰세요"를 붙인다. 구버전 naby가 v2를 거부하는 것은 기존 규칙이고 의도된 동작이다.
- `.md`의 frontmatter에는 참가자의 `skills`·`mcpServers`·`color`를 Claude Code 필드 그대로 적는다(`skills:`, `mcpServers:`, `color:`). Claude Code가 그대로 읽는 형태라 왕복 테스트로 확인할 수 있다.
- `knowledge`는 `.md`에 **인라인하지 않는다.** 20개·16 KB면 파일이 커지고, Claude Code는 `knowledge`를 모른다. 사이드카에만 간다. `.md` 본문 끝 주석에 "N knowledge items in the sidecar"를 남긴다.
- 여러 참가자 묶음 내보내기(agent-export §6 미결정)는 **zip 하나에 `<name>.md` + `<name>.naby.json` 쌍 N개 + `manifest.json {formatVersion:2, exportedAt, agents:[name…]}`**로 정한다. 1차 UI는 한 명씩이고 묶음은 액션만 둔다.

## 6. 검증 계획

- **스파이크 `spike-participant-import`**(`src/spikes/`): 어댑터 3종의 픽스처(`src/spikes/fixtures/import/`: `explorer.md`, `minji.v2.json`, `minji.v3.png`, `legacy.v1.naby.json`, `broken-*`) → 플랜의 필드·손실 목록을 스냅샷과 비교. **악의적 입력**: `id`·`kind:'persona'`·`stage:'butterfly'`·`toolRefs:['Bash']`·`autonomy`를 심은 파일이 아무 효과 없음, 시크릿이 가려짐, 이름 충돌, `formatVersion:3` 거부, PNG에 `chara` 청크가 없을 때 거부, 64 KB 넘는 아이콘이 이모지로 떨어짐, 로어북 21개째 `dropped`. 왕복: `participant.export` → `importParticipant` → 같은 `profile`(origin 제외). 목표 35+.
- **셸 vitest**: `participantImport.test.ts`(액션 두 단계, `apply` 전 쓰기 없음, `decisions`로 사용자가 description을 고친 값이 반영), `ParticipantImportDialog.test.tsx`(손실 보고 렌더).
- **실제 앱에서 확인**: 프로토타입 시나리오 5를 prod 빌드에서 직접 실행해 본다. 실제 SillyTavern 카드 하나(공개 샘플)를 JSON·PNG로 각각 가져온다.

## 7. 거절한 대안

- **포맷마다 변환 스크립트를 셸에 두기**: 어댑터는 프로바이더·UI와 무관한 순수 규칙이라 런타임이 맞다(CLAUDE.md "어느 레이어에 쓰는가").
- **LLM으로 변환하기**: 결정적이지 않고 테스트할 수 없다. 매핑이 애매한 곳(description 합성)은 사용자가 미리보기에서 고친다.
- **`.md`에 knowledge 인라인**: 파일이 커지고 Claude Code가 모르는 내용이 프롬프트에 섞인다.
- **참가자 가져오기를 기존 `agent.import`에 합치기**: 그 액션은 `kind:'custom'`과 성장 원장을 전제한다. 경로를 나눠야 "경로가 `kind`를 정한다"(multi-agent-chat R4.3)가 성립한다.

## 8. 구현 상태 (MAC-M4, 2026-10-16)

Opus 에이전트가 구현했고 Fable 5.1이 스크린샷과 수치로 확인했다. 커밋 전이다.

- ✅ **런타임 `src/runtime/import/`**: `types.ts`·`index.ts`(`importParticipant`, 0.5 임계 감지)·`finalize.ts`(§4 7단계)·어댑터 `claudeAgentMd.ts`·`nabySidecar.ts`·`characterCard.ts`·보조 `png.ts`(tEXt 청크 읽기·쓰기)·`yamlLite.ts`·`common.ts`. `participant-export.ts`(`buildParticipantExport`·`buildParticipantBundle`). `runtime-entry.ts` 내보내기.
- ✅ **셸**: `server/lib/participantImport.ts`(환경 구성: 도구 목록·승인된 MCP 서버·켜진 스킬, 사용자 수정 적용, apply 때 이름 재검사, 업로드 8 MB 상한). 액션 `participant.import`·`participant.export`·`participant.exportBundle`·`tools.list`. `agent.import`는 v2 파일에 안내 메시지(i18n 키)를 답하고 `AgentImportButton`이 보인다. `harnessImporter.ts`의 `parseSubagentArtifact`는 런타임 사본을 부른다(사본 하나). 클라이언트 `ParticipantImportDialog.tsx`(참가자 절 안에 인라인, 모달 위 모달이 아님), `ParticipantSection`의 가져오기·내보내기 버튼과 출처 배지, 편집기 도구 칩.
- ✅ **검증**: `spike:participant-import` 64/64(픽스처 `src/spikes/fixtures/import/`: `explorer.md`·`minji.v2.json`·`minji.v3.png`·`legacy.v1.naby.json`·`broken-{empty.md,future.naby.json,hostile.naby.json,no-card.png,card.charx}`; PNG·CHARX는 `generate.ts`가 만들고 스파이크가 커밋된 파일과 일치를 확인). 회귀 export·import·participants·participant-history·autonomy·02 통과. 셸 `participantImport.test.ts` 16 · `ParticipantImportDialog.test.tsx` 10 + 라운드·텔레그램·UI 테스트 추가. 전체 236 파일 / 4481. 타입체크 셸 12·루트 29.

**구현 결정.**
1. **YAML**: 런타임에 YAML 라이브러리가 없어 의존성 없는 `yamlLite.ts`를 썼다. js-yaml보다 너그럽다(평문 description 안의 `: ` 허용). 하네스 가져오기는 여전히 js-yaml을 넘겨 주므로 기존 동작이 같다.
2. **인터페이스 보강**: `ImportLoss.value`가 구체적인 도구·서버·항목 이름을 담는다. `parse(input, env?)`·`importParticipant(…, {env})`가 기계 환경(설치 도구·MCP·스킬)을 받고, 비우면 아무 도구도 주지 않는다. 손실·경고는 문장이 아니라 **키**이고 클라이언트가 번역한다.
3. **파일이 정한 값 무시**는 `extensions` 안에서도 어느 깊이든 벗긴다. 로어북 항목의 `id`도 벗겨지므로 보고는 키당 한 줄로 접는다.
4. **`file` 지식은 버린다.** 다른 기계의 경로는 여기 없고, 악의적 파일이 비밀 파일을 가리킬 수 있다. `memoryScope`는 가져올 때 `session`으로 강제하고 다른 값은 `defaulted`로 보고한다.
5. **아바타**: Node에 canvas가 없어 축소하지 못한다. 카드 PNG에서 텍스트 청크를 뺀 것이 64 KB를 넘으면 이모지(🤖)로 대체하고 보고한다. 원격 아이콘 URL은 받지 않고(보고), SVG는 거부한다. 원본이 `extensions` 128 KB를 넘기면 `{omitted, bytes}`로 두고 보고한다.
6. **zip**은 기존 `src/runtime/zip.ts`의 `buildZip`을 비압축으로 재사용했다. 새 의존성 없음.
7. 내보내기의 `color:`는 hex가 Claude 색 이름과 정확히 맞으면 이름, 아니면 hex. Claude의 `mcp__server__tool`은 naby의 `server__tool`로 바꾸고 `merged`로 보고. `decisions`는 `displayName`도 받는다.

**남은 것**: CHARX(zip) 가져오기(`problems`로 거부), M365·CrewAI·Dify·Letta 어댑터(§3.4), 캐릭터 카드로 내보내기, A2A 카드 투영(R4.5). 실제 SillyTavern 공개 샘플로의 실기는 사용자 실기 때 함께.

## 변경 이력

- 0.2.0 (2026-10-16) — §8 구현 상태(MAC-M4 완료, 구현 결정 7건, 남은 것).
- 0.1.1 (2026-10-16) — spec-guard·교정 반영: `formatVersion` 2는 참가자 사이드카에만(`PARTICIPANT_EXPORT_FORMAT_VERSION`), `agent.import`의 거부 안내, 용어 통일(가져오기·계획).
- 0.1.0 (2026-10-16) — 초안. multi-agent-chat 0.2.0 R4·D11의 설계. 어댑터 인터페이스, 포맷 3종 매핑, 공통 파이프라인 7단계, 사이드카 v2, 묶음 zip 형식, 검증 계획.
