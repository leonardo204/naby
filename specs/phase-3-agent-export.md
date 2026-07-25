---
id: phase-3-agent-export
title: Phase 3 P3-M6 — 학습된 에이전트 내보내기 (Claude Code 서브에이전트 형식)
type: design
version: 0.2.0
status: active
scope: 학습이 쌓인 페르소나 에이전트를 다른 환경에서 쓰기 위해 Claude Code 표준 서브에이전트 `.md`와 무손실 사이드카로 패키징하는 설계. 무엇을 담고 무엇을 빼는지, 단계 표기를 어떻게 위조 불가하게 두는지를 정한다. 신뢰 지표 계산은 butterfly-trust-meter, 기억 캡처는 persona-agent P3-M4가 다룬다.
related: [phase-3-butterfly-trust-meter, phase-3-persona-agent, phase-3-checkin-contracts, harness-portability-strategy, phase-1_6-harness-contracts, phase-1_5-memory-contracts]
updated: 2026-07-26
---

# 학습된 에이전트 내보내기

> 이 문서가 답하는 질문 — **"naby에서 키운 페르소나를 다른 환경으로 옮기려면 무엇을 어떤 형식으로 함께 보내야 하고, 무엇은 보내지 말아야 하는가?"**

하네스 이식성 전략의 **D2**(교환 포맷은 Claude Code 아티팩트를 채택하고 감싼다)와 **D5**(셋 export/import)를 페르소나 에이전트에 적용한 것이다. 새 원칙이 아니라 이미 정한 원칙의 적용이다.

## 1. 두 파일로 패키징한다

### `<name>.md` — 순정 Claude Code 서브에이전트

naby 없이 그대로 동작한다. frontmatter는 `name` / `description` / `model?` / `tools?`이고 본문이 시스템 프롬프트다.

**형식을 추측하지 않았다.** 셸에 이미 있는 임포터 `parseSubagentArtifact`(`lib/harnessImporter.ts`)가 `name`/`description`/`model`/`tools`(그리고 `allowed-tools`·`allowedTools`)를 읽고 본문을 `systemPrompt`로 삼는다. 내보내기는 **그 파서가 되읽는 형태로** 만든다. 덕분에 왕복(export → parse → 같은 필드)이 테스트 가능하다.

본문 구성:

```
<페르소나 지시문>

## What naby has learned about this user

- (user/semantic) prefers-metric-units: 거리와 무게는 미터법으로 쓴다.
- (project/procedural) build-command: 빌드는 npm run build:app으로 한다.

<!-- exported from naby on 2026-07-26 (UTC) · 2 confirmed memories · reached the "butterfly" stage there (a record, not a permission) -->
```

구조를 나타내는 부분(제목, 주석)은 **영어로 쓴다.** 이 파일은 다른 도구와 모델이 읽는 산출물이고 어느 로케일에서 열릴지 모른다. 배운 내용 자체는 기록된 언어 그대로 남는다.

날짜에 **(UTC)를 붙인다.** 붙이지 않으면 로컬 시각으로 읽히고, 자정 직후에 내보낸 사용자는 어제 날짜를 본다.

학습 내용을 **본문에 인라인한다.** 파일 하나만 옮겨도 배운 것이 실제로 작동해야 한다. 줄 형식은 naby가 턴에 주입할 때 쓰는 것(`renderMemoryLine`)과 같게 해서, 다른 환경의 모델도 naby에서와 같은 방식으로 읽는다.

### `<name>.naby.json` — 무손실 사이드카

Claude Code는 무시하고 naby는 정확히 되읽는다.

| 담는 것 | 이유 |
|---|---|
| 에이전트 행 (kind, memoryScope, autonomy, toolRefs) | `.md` frontmatter가 표현하지 못하는 naby 고유 필드 |
| 기억 데이터셋 전체 + provenance | `.md`는 값만 담는다. 출처·신뢰도·시각이 있어야 재수입 후에도 쓰기 게이트가 판단할 수 있다 |
| 성장 원장 (`eval_events`) | 재수입 시 알 단계로 초기화되지 않고 단계를 **다시 계산**한다 |
| `formatVersion` | 나중에 마이그레이션이 필요할 때 |

## 2. 무엇을 빼는가

- **`proposed` 기억은 내보내지 않는다.** 사람이 검토하지 않은 내용이다. 내보내면 미검증 데이터를 다른 환경으로 세탁하는 셈이 된다.
- **`session` 스코프는 뺀다.** 정의상 그 대화에서만 유효하다.
- **시크릿 2차 검사를 돌린다.** 캡처 단계(`looksLikeSecret`)에서 이미 거부하지만, 내보내기는 데이터가 기기를 떠나는 순간이라 값싼 보험이다. `app.db` 암호화가 미결(`personalization-strategy` §7.2)인 상태에서 토큰이 파일로 나가면 평문 자격증명이 된다. 걸린 항목은 버리고 **개수를 보고한다** — 조용히 빠지면 사용자는 다 나갔다고 믿는다.
- 내보내기 전에 **파일에 무엇이 들었는지 밝히고 확인을 받는다.** "이 파일에는 naby가 당신에 대해 배운 내용이 들어 있습니다."

구현에서 더한 것 셋.

- **원장의 자유 서술도 훑는다.** 사용자가 직접 적어 준 답(`correction`)이나 질문에 토큰이 들어 있을 수 있다. 행을 버리지 않고 그 글만 가린다 — 행은 **에이전트에 대한 증거**이고, 버리면 측정된 이력이 조용히 달라진다.
- **에이전트 지시문은 가리지 않고 알린다.** 지우면 에이전트가 다르게 움직이므로 판단은 사용자 몫이다. 대신 확인 화면에서 경고한다.
- **두 단계로 나눈다.** 첫 클릭은 파일을 만들고 보고만 낸다(아무것도 쓰지 않는다). 두 번째 클릭에서 저장한다. "잘 내보냈습니다"는 이 파일에 대한 동의가 아니다.

## 3. 단계는 주장이 아니라 출처다

신뢰 지표를 검증 기반으로 만들어 놓고 내보내기에서 무너지면 의미가 없다. 순정 Claude Code는 `stage: butterfly`라는 값을 검증할 방법이 없고, 사람이 손으로 고쳐 쓸 수도 있다.

- `.md`에는 **사실 기록만** 남긴다 — "naby에서 나비 단계에 도달, 2026-07-25 기준". 권한을 주는 값이 아니라 이력이다.
- naby로 재수입할 때는 **그 표기를 믿지 않고** 사이드카의 원장으로 단계를 다시 계산한다. 원장이 없으면 알 단계에서 시작한다.

즉 내보낸 파일이 다른 naby에서 멘션 권한을 **선언할 수는 없다.** 권한은 늘 그 기기의 원장에서 다시 나온다.

같은 이유로 사이드카의 복원용 `agent` 블록에는 **`id`도 `kind`도 없다.** id를 복원하면 내보낸 페르소나가 받는 기기의 내장 페르소나와 충돌하거나 덮어쓸 수 있고, `kind: 'persona'`를 복원하면 그 기기가 이미 채운 자리를 주장한다. 둘은 `origin` 아래 provenance로만 남아서 아무것도 할 수 없다. 사이드카의 성장 값은 `growthAtExport`라고 이름 붙여 **살아 있는 상태로 오해될 수 없게** 한다.

## 4. 임포트한 에이전트는 신뢰할 수 없는 콘텐츠다

하네스 이식성 전략 **D6**과 같은 취급을 받는다. 동료가 준 페르소나에는 프롬프트 인젝션이 숨어 있을 수 있다. 임포트한 에이전트는 **기본 비활성**, provenance 기록, 검토 후 활성이며, 함께 들어온 기억은 `external` 등급이므로 쓰기 게이트가 `user`/`org` 스코프 쓰기를 아예 막는다(`phase-1_5-memory-contracts` §4 불변식 3).

## 5. 검증 상태

- ✅ **왕복** — 내보낸 `.md`를 **실제 임포터** `parseSubagentArtifact`로 되읽어 name/description/model/toolRefs/systemPrompt가 일치한다. YAML 문장부호가 가득한 description도 그대로 돌아온다(따옴표 없이 내보내면 두 번째 콜론에서 잘리고, 그 실패는 조용하다).
- ✅ **음성 테스트** — `proposed`·`session`·시크릿이 산출물에 없다. 자격증명을 **말하는** 메모("관리자에게 물어보세요")는 나간다 — 오탐이 실제 메모를 먹으면 사용자가 검사를 신뢰하지 않는다.
- ✅ **단계는 주장이 될 수 없다** — 임포터가 되읽은 구조에 stage/growth 필드가 아예 없다. frontmatter에 `stage: butterfly`를 손으로 적어 넣은 파일도 그 키가 갈 곳이 없다.
- ✅ 라이브(prod 서버): 확인된 기억 2개 반출, 검토 전 1개·시크릿 1개 보류, 원장 질문 1곳 가림, 유출 없음.
- ⬜ **임포트는 아직 없다.** 사이드카로 복원하고 단계를 재계산하는 경로(§3·§4)는 다음 마일스톤이다. 쓰지 않을 파서를 미리 넣는 것은 이 프로젝트가 이미 두 번 겪은 dormant 패턴이다.

검증 명령: `npm run spike:export`(11/11, 순수 규칙) · 셸 `agentExport.test.ts`(11건, 실제 임포터 왕복).

## 6. 미결정

- 1차는 **브라우저 저장(Blob 내려받기) 파일 두 개**다. 서버가 파일을 쓰지 않으니 경로 검증 표면이 늘지 않고, 패키지 앱과 브라우저에서 같게 동작한다. zip 하나로 묶을지는 하네스 셋 export(D5)와 형식을 맞출 때 함께 정한다.
- 여러 에이전트를 한 번에 내보낼 때의 매니페스트. D5의 "하네스 셋" 번들 형식을 그대로 쓸 후보.
- **MCP 도구 이름은 `tools:`에 그대로 나간다.** 받는 환경에 그 MCP 서버가 없으면 존재하지 않는 도구를 가리킨다. 순정 Claude Code는 없는 도구 이름을 무시하므로 깨지지는 않지만, 사이드카에 필요한 서버 목록을 함께 실을지는 정하지 않았다.
- `report.droppedSession`은 실무에서 항상 0이다. 셸이 session 스코프를 아예 조회하지 않기 때문이다. 런타임 쪽 필터는 다른 호출자를 위한 이중 방어로 남긴다.
