---
id: phase-3-agent-export
title: Phase 3 P3-M6 — 학습된 에이전트 내보내기 (Claude Code 서브에이전트 형식)
type: design
version: 0.1.0
status: review
scope: 학습이 쌓인 페르소나 에이전트를 다른 환경에서 쓰기 위해 Claude Code 표준 서브에이전트 `.md`와 무손실 사이드카로 패키징하는 설계. 무엇을 담고 무엇을 빼는지, 단계 표기를 어떻게 위조 불가하게 두는지를 정한다. 신뢰 지표 계산은 butterfly-trust-meter, 기억 캡처는 persona-agent P3-M4가 다룬다.
related: [phase-3-butterfly-trust-meter, phase-3-persona-agent, phase-3-checkin-contracts, harness-portability-strategy, phase-1_6-harness-contracts, phase-1_5-memory-contracts]
updated: 2026-07-25
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

## 이 사용자에 대해 배운 것
- (user/semantic) prefers-metric-units: 거리와 무게는 미터법으로 쓴다.
- (project/procedural) build-command: 빌드는 npm run build:app으로 한다.

<!-- naby에서 내보냄 · 2026-07-25 · 확인된 기억 12개 · 나비 단계 -->
```

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

## 3. 단계는 주장이 아니라 출처다

신뢰 지표를 검증 기반으로 만들어 놓고 내보내기에서 무너지면 의미가 없다. 순정 Claude Code는 `stage: butterfly`라는 값을 검증할 방법이 없고, 사람이 손으로 고쳐 쓸 수도 있다.

- `.md`에는 **사실 기록만** 남긴다 — "naby에서 나비 단계에 도달, 2026-07-25 기준". 권한을 주는 값이 아니라 이력이다.
- naby로 재수입할 때는 **그 표기를 믿지 않고** 사이드카의 원장으로 단계를 다시 계산한다. 원장이 없으면 알 단계에서 시작한다.

즉 내보낸 파일이 다른 naby에서 멘션 권한을 **선언할 수는 없다.** 권한은 늘 그 기기의 원장에서 다시 나온다.

## 4. 임포트한 에이전트는 신뢰할 수 없는 콘텐츠다

하네스 이식성 전략 **D6**과 같은 취급을 받는다. 동료가 준 페르소나에는 프롬프트 인젝션이 숨어 있을 수 있다. 임포트한 에이전트는 **기본 비활성**, provenance 기록, 검토 후 활성이며, 함께 들어온 기억은 `external` 등급이므로 쓰기 게이트가 `user`/`org` 스코프 쓰기를 아예 막는다(`phase-1_5-memory-contracts` §4 불변식 3).

## 5. 검증 계획

- 왕복: 내보낸 `.md`를 `parseSubagentArtifact`로 되읽어 name/description/model/toolRefs/systemPrompt가 일치한다.
- `proposed`·`session`·시크릿이 산출물에 없다(음성 테스트).
- 사이드카만으로 에이전트와 기억과 원장이 복원되고, 단계가 원본과 같게 **재계산**된다.
- 단계 표기를 손으로 `butterfly`로 고친 파일을 임포트해도 권한이 올라가지 않는다.

## 6. 미결정

- 내보내기 산출물의 위치와 형태(파일 두 개 대 zip 하나). 하네스 셋 export(D5)와 형식을 맞출지.
- 여러 에이전트를 한 번에 내보낼 때의 매니페스트. D5의 "하네스 셋" 번들 형식을 그대로 쓸 후보.
