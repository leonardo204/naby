---
id: harness-portability-strategy
title: Naby 하네스 이식성 전략 — 스킬·서브에이전트·커맨드를 벤더 밖 내 자산으로
type: design
version: 0.1.0
status: draft
scope: 하네스(스킬·서브에이전트·슬래시커맨드)를 특정 엔진(Claude Code)에 묶인 상속물이 아니라 Naby Layer가 소유·이식·공유하는 1급 자산으로 재정의하는 전략 — 현재 두 하네스 평면과 dev/prod 비대칭 진단, 6대 설계 결정, 프로바이더 독립 하네스 런타임, import/export·팀 공유, 임포트 하네스의 오염 방어, 그리고 Phase 배치·태스크 제안. 실제 스키마·태스크는 검증 후 Phase 문서로 분리한다.
related: [personalized-agent-desktop-app, personalization-strategy, phase-1-contracts, phase-2-personalization-hitl, phase-1_5-memory-contracts]
updated: 2026-07-23
---

# Naby 하네스 이식성 전략

> 이 문서가 답하는 질문 — **"내 스킬·서브에이전트·커맨드를 특정 벤더 밖에 두고, 팀과 나누고, 어떤 프로바이더에서도 쓰려면 지금 무엇이 빠져 있고 무엇을 결정해야 하는가?"**
>
> **스펙 연동** — [`personalization-strategy`](personalization-strategy.md)의 **자매 문서**다. 그쪽이 *기억*의 소유권·이식성을 다룬다면, 이 문서는 *하네스*의 소유권·이식성을 다룬다. 둘은 같은 명제의 두 축이다: **"모델을 바꿔도 내가 남는다."** 실행은 검증 후 `phase-2_5-harness-portability`(impl, 예정) + 하네스 계약 문서(interface, 예정)로 내려간다.

**핵심 전제** — 하네스 이식성은 개인화 전략의 연장이다. 기억이 벤더 밖 내 자산이어야 하듯, 하네스도 벤더 밖 내 자산이어야 한다. 그리고 이건 **사내 배포에서 가장 강력해진다** — 팀이 만든 하네스 셋을 상속받는 순간, 개인 데이터 0인 신규 사용자도 즉시 유용해진다.

---

## 1. 배경 — 코드가 말해주는 현실 (2026-07-23 `main` 실사)

지금 Naby에는 **서로 무관한 하네스 평면이 두 개** 겹쳐 있다.

| 평면 | 정체 | 어느 엔진 | 사용자 제어 | 근거 |
|---|---|---|---|---|
| **A. Agent SDK 파일시스템 하네스** | 진짜 Claude Code 스킬·서브에이전트·슬래시커맨드·CLAUDE.md·hooks (`~/.claude` + 프로젝트 `.claude/`) | **dev 엔진 전용** (`ClaudeAgentSdkEngine`) | 앱 밖에서 파일 편집으로만 | `src/engines/claude-agent-sdk-engine.ts` — `settingSources: ['user','project','local']`, 빌트인 툴 활성 유지 |
| **B. 셸 슬래시 팔레트** (`/plan /qa /ap /fx /ex /go` 등) | cockpit 포크에 **하드코딩된** 프롬프트 템플릿 | 모든 엔진 | **불가 (전부 하드코딩)** | `shell/.../server/api/commands.ts`(BUILTIN_COMMANDS), `.../server/lib/slashCommands.ts`, `client/ChatInput.tsx`(`/plan`) |

- **평면 A는 상속이지 소유가 아니다.** dev 엔진은 사실상 맨 `claude` CLI와 동일한 하네스로 돈다. 격리는 툴 목록이 아니라 **PreToolUse 게이트** 하나이며, 기본값 `gate.allowChanges=ON`은 allow-all이다 (`src/runtime/gate.ts` `phase1HarnessFloor`은 토글 OFF일 때만 read-only 바닥).
- **평면 B는 하드코딩이다.** `source:"builtin"` → "기본 제공" 뱃지. 추가/삭제/import/export **CRUD가 없다.** `~/.cockpit/skills.json` 잔재 경로가 있으나 앱에서 **쓰기 불가**(손 편집)이고 팔레트에도 안 뜬다.
- **prod `AiSdkEngine`(5개 프로바이더)은 하네스 개념이 0.** system prompt + execute-less 툴 + MCP뿐이다 (`src/engines/ai-sdk-engine.ts`).
- **스펙에도 하네스 이식성·스킬 관리·서브에이전트 관리 계획이 없다.** 기존 "import/export"는 전부 `~/.cockpit/projects.json` 프로젝트 임포트 얘기다.

### 1.1 결정적 문제 — dev/prod 비대칭 절벽

dev(Claude) 엔진에선 풍부한 하네스가 상속되는데, **prod(Azure/Gemini/OpenAI) 엔진으로 바꾸는 순간 스킬·서브에이전트·커맨드가 전부 사라진다.** 개인화 전략이 경계한 "계기판만 있고 조향장치가 없는" 상태의 하네스판이다 — "dev에서 되던 게 prod에서 안 됨"이 하네스 차원에서 그대로 발생한다. Naby Layer 설계(§3.6)가 프로바이더-네이티브 스토어(`~/.claude`)를 **엔진 아래로** 밀어둔 것은 세션/메모리엔 옳지만, 하네스를 그 아래 두면 이식성이 원천 봉쇄된다.

### 1.2 문제 정의

> **"하네스는 지금 Claude Code에서 빌려 쓰는 상속물이거나(dev 전용), 손댈 수 없는 하드코딩이다. 내가 만들고·팀과 나누고·어느 프로바이더에서도 쓰는 자산이 되려면, Naby Layer가 하네스를 1급 엔티티로 소유해야 한다."**

---

## 2. 컨셉 — 하네스를 Naby가 소유하는 이식 자산으로

> **"내가 조립한 스킬·서브에이전트·커맨드는, 모델을 바꿔도·기기를 바꿔도·동료에게 건네도 그대로 작동하는 내 것이다."**

이는 프로젝트/세션/메모리를 Naby Layer 소유로 만든 **v0.7 realignment의 하네스 확장**이다. 소유 엔티티 목록에 **Harness**가 추가된다: *Projects · Sessions · Agents · Context · Memory · **Harness***.

```
┌──────────────────────────────────────────────────────────────┐
│                     NABY LAYER  (we own)                       │
│  Projects · Sessions · Context · Memory · HARNESS(skills·      │
│  subagents·commands·sets)  — app.db, provider-independent      │
│  ── 하네스 런타임이 모든 엔진에 동일 주입 ──                   │
└───────────────▲───────────────────────▲──────────────────────┘
                │ inject harness         │ (dev만) settingSources로
                ▼                        ▼  기존 ~/.claude를 IMPORT 소스로
   ┌────────────────────┐    ┌────────────────────┐
   │  AiSdkEngine (prod) │    │ ClaudeAgentSdkEngine│
   │  5 providers        │    │ (dev/test, Claude)  │
   └────────────────────┘    └────────────────────┘
```

---

## 3. 6대 설계 결정 (권고안 포함)

실행 문서가 확정할 결정. 권고는 하되, 진짜 갈림길은 §6 open question으로 남긴다.

- **D1 · Naby Layer가 하네스를 소유** *(권고: 채택)* — 스킬·서브에이전트·커맨드·**하네스 셋**(명명된 번들)을 `app.db`에 프로바이더 독립으로 저장. 메모리처럼 스코프(user/project/org) 가능.
- **D2 · 교환 포맷은 Claude Code 아티팩트를 채택·래핑** *(권고: adopt-and-wrap)* — SKILL.md / 서브에이전트 `.md`(frontmatter) / 커맨드 `.md`를 그대로 import·export 포맷으로 삼는다. 이유: (a) `~/.claude`와 동료의 기존 Claude Code 셋을 **공짜로 임포트**, (b) 사실상 표준, (c) export가 이식성을 유지. Naby 모델이 이를 감싼다.
- **D3 · 프로바이더 독립 하네스 런타임 구축** *(권고: 단계적)* — prod 엔진엔 하네스 런타임이 없으므로 Naby가 직접 만든다. 난이도가 갈린다:
  - **커맨드** = 프롬프트 확장 → 이미 평면 B가 하는 방식. **프로바이더 독립 즉시 가능**(가장 싼 승리).
  - **스킬** = 트리거 시 SKILL.md 주입(+선택 툴) → Naby가 로딩·점진적 공개를 직접 하면 독립. 중간.
  - **서브에이전트** = 자체 시스템프롬프트·툴·모델을 가진 하위 컨텍스트 spawn → **Naby 런타임이 서브에이전트 오케스트레이션을 자체 구현**해야 함(AI SDK는 제공 안 함). 가장 큰 작업이며 Phase 2 루프 소유와 겹침.
- **D4 · dev 상속 하네스는 런타임이 아니라 IMPORT 소스로 강등** *(권고: import-then-own)* — 지금 SDK가 `~/.claude`를 직접 로드하는 것을, **Naby 스토어로 한 번 임포트 후 자체 런타임으로 실행**해 엔진 간 동작을 동일화. `projects.json` 일회 임포트 + 메모리 realignment와 같은 패턴.
- **D5 · 팀 공유 = 하네스 셋 export → import** *(권고: 번들 포맷)* — 사내 배포의 강점. "하네스 셋" = 스킬+서브에이전트+커맨드+매니페스트의 명명·버전 번들. export=파일/폴더(서명 가능), import=충돌 처리 병합. **org 스코프 하네스**는 org 스코프 메모리의 자매.
- **D6 · 임포트 하네스는 신뢰할 수 없는 콘텐츠** *(권고: 게이트+provenance+검토 후 활성)* — 동료의 스킬/서브에이전트는 프롬프트 인젝션·위험 툴 사용을 품을 수 있다. 메모리 오염(ASI06, [`personalization-strategy`](personalization-strategy.md) §7.1)과 동일 위협. 임포트 항목은 **기본 비활성**, provenance 기록, 게이트 통과 필수, 활성 전 검토. → [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md) §4 쓰기 게이트의 신뢰 등급 모델을 하네스에도 적용.

---

## 4. 사용자가 하려던 것 → 어느 결정이 답하나

| 오너가 물은 것 | 답하는 결정 | 결과 |
|---|---|---|
| 이 커맨드들 추가/삭제 컨트롤 | D1 소유 + D3(커맨드) | 팔레트가 하드코딩→CRUD 가능 자산으로 |
| 사내 다른 사람이 만든 하네스 import | D2 포맷 + D5 셋 + D6 게이트 | 동료 번들을 검토 후 병합 |
| 내 하네스 set export | D1 + D5 | 명명·버전 번들로 반출 |
| 특정 스킬만 내 Naby로 | D2 + D5(선택 병합) | 번들에서 항목 단위 임포트 |
| 서브에이전트 추가 | D1 + D3(서브에이전트) | Naby 자체 오케스트레이션 위에 등록 |

---

## 5. Phase 배치 및 태스크 제안

하네스 런타임(D3)은 Phase 2의 툴/루프 소유에 의존한다. 단, **커맨드 이식(D3-커맨드)은 템플릿뿐이라 더 일찍 뽑아낼 수 있다.** 제안: **Phase 2.5 — Harness Portability**(2a/2b 뒤), 서브에이전트 오케스트레이션은 Phase 3으로 밀릴 수 있음. *(Phase 경계는 §6 open question.)*

**Phase 2.5 최소 태스크 (제안 — 검증 후 impl 문서로 확정)**

| ID | 항목 | 완료 기준 | 난이도 |
|---|---|---|---|
| HP-01 | 하네스 소유 스키마 (skills·subagents·commands·sets + provenance·enabled) | 세션/프로젝트 삭제가 하네스를 지우지 않음; user/org 스코프 존재 | S–M |
| HP-02 | 커맨드 CRUD + 프로바이더 독립 확장 | 하드코딩 팔레트가 사용자 추가/삭제 가능; 5개 엔진 전부 동일 확장 | S |
| HP-03 | 스킬 런타임 (자체 로딩·점진적 공개·주입) | 스킬이 dev/prod 양쪽에서 동일 트리거·주입 | M |
| HP-04 | `~/.claude` / `.claude/` 임포터 (D4) | 기존 Claude Code 스킬·서브에이전트·커맨드를 Naby 스토어로 무손실 임포트 | M |
| HP-05 | 하네스 셋 export/import + 병합·충돌 (D5) | 번들 반출→타 기기·동료가 임포트, 항목 단위 선택 | M |
| HP-06 | 임포트 게이트 + provenance + 검토 UI (D6) | 임포트 항목 기본 비활성; 외부 유래 스킬은 검토 전 실행 불가; 오염 페이로드 음성 테스트 | M |
| HP-07 | 서브에이전트 오케스트레이션 (프로바이더 독립) | Naby 런타임이 서브에이전트를 spawn·게이트·관찰; 5개 엔진에서 동작 | **L (Phase 3 후보)** |
| HP-08 | org 스코프 하네스 상속 (팀 페르소나) | 신규 사용자가 조직 하네스 셋을 기본 상속 | M |

- **가장 싼 첫 승리**: HP-02(커맨드). 지금 하드코딩된 팔레트를 CRUD로 바꾸고 5개 프로바이더에 동일 적용 — 비대칭 절벽의 첫 조각을 즉시 메운다.
- **가장 큰 작업**: HP-07(서브에이전트). Phase 2 루프 소유와 겹치므로 그 뒤에.

---

## 6. Open questions (실행 문서로 승계)

- **Phase 경계** — Harness Portability를 Phase 2.5 단일로 둘지, 커맨드(HP-02)만 앞당기고 서브에이전트(HP-07)는 Phase 3로 분리할지.
- **자체 포맷 vs Claude Code 포맷** — D2는 채택·래핑을 권고하나, Naby 고유 능력(멀티 프로바이더 모델 지정, 메모리 연동)을 표현하려면 확장 필드가 필요. 확장을 어디까지.
- **서브에이전트 프로바이더 독립성** — 서브에이전트가 부모와 다른 프로바이더/모델로 돌 수 있어야 하나? (멀티 프로바이더의 실질 이점이나 복잡도 급증.)
- **hooks 이식** — Claude Code hooks까지 이식 대상인가, 아니면 Naby 게이트/이벤트로 흡수하고 이식 범위에서 제외인가. (보안상 hooks 임포트는 임의 코드 실행 위험.)
- **SKILL.md 실행 호환** — 임포트한 스킬이 참조하는 툴이 Naby 툴셋에 없을 때의 처리(스텁·비활성·경고).
- **셋 서명·신뢰 체계** — 사내 배포에서 org 하네스 셋의 출처 보증(서명)과 배포 채널.

---

## 7. 참고

- 자매 전략: [`personalization-strategy`](personalization-strategy.md) — 기억의 소유권·이식성. 하네스는 같은 명제의 다른 축.
- 소유 모델: [`personalized-agent-desktop-app`](personalized-agent-desktop-app.md) §3.6 (Naby Layer가 projects/sessions/memory/context 소유 — 여기에 harness가 합류).
- 오염 방어 모델 재사용: [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md) §4 (신뢰 등급·provenance·검토 후 활성).
- 하네스가 무엇을 할 수 있는지의 통제: [`phase-2-personalization-hitl`](../impl/phase-2-personalization-hitl.md) (게이트·가드레일). 이식성은 *무엇을 가지느냐*, 게이트는 *무엇을 하게 두느냐* — 직교한다.
