---
id: harness-portability-strategy
title: Naby 하네스 이식성 전략 — 스킬·서브에이전트·커맨드를 벤더 밖 내 자산으로
type: design
version: 0.2.0
status: review
scope: 하네스(스킬·서브에이전트·슬래시커맨드)를 특정 엔진(Claude Code)에 묶인 상속물이 아니라 Naby Layer가 소유하고 옮기고 나누는 1급 자산으로 다시 정의하는 전략. 지금 하네스 평면이 둘로 갈라진 상태와 dev/prod 비대칭을 진단하고, 설계 결정 여섯 가지, 프로바이더 독립 하네스 런타임, import/export와 팀 공유, 임포트한 하네스의 오염 방어를 다룬다. v0.2에서 phase 경계를 정리했다. 코어는 Phase 1.6으로 Phase 2보다 먼저 하고, 툴 실행에 의존하는 조각만 Phase 2.5로 미룬다.
related: [personalized-agent-desktop-app, personalization-strategy, phase-1-contracts, phase-2-personalization-hitl, phase-1_5-memory-contracts, phase-1_6-harness-ownership, phase-1_6-harness-contracts]
updated: 2026-07-23
---

# Naby 하네스 이식성 전략

> 이 문서가 답하는 질문 — **"내 스킬·서브에이전트·커맨드를 특정 벤더 밖에 두고, 팀과 나누고, 어떤 프로바이더에서도 쓰려면 지금 무엇이 빠져 있고 무엇을 결정해야 하는가?"**
>
> **스펙 연동** — [`personalization-strategy`](personalization-strategy.md)의 **자매 문서**다. 그쪽이 *기억*의 소유권과 이식성을 다룬다면 이 문서는 *하네스*의 소유권과 이식성을 다룬다. 둘은 같은 명제의 두 축이다. **"모델을 바꿔도 내가 남는다."** 실행은 검증한 뒤 `phase-2_5-harness-portability`(impl, 예정)와 하네스 계약 문서(interface, 예정)로 내려간다.

**핵심 전제** — 하네스 이식성은 개인화 전략의 연장이다. 기억이 벤더 밖 내 자산이어야 하듯 하네스도 벤더 밖 내 자산이어야 한다. 그리고 이 값어치는 **사내 배포에서 가장 커진다.** 팀이 만든 하네스 셋을 물려받는 순간, 개인 데이터가 하나도 없는 새 사용자도 곧바로 쓸 만해진다.

---

## 1. 배경 — 코드가 말해주는 현실 (2026-07-23 `main` 실사)

지금 Naby에는 **서로 무관한 하네스 평면이 두 개** 겹쳐 있다.

| 평면 | 정체 | 어느 엔진 | 사용자 제어 | 근거 |
|---|---|---|---|---|
| **A. Agent SDK 파일시스템 하네스** | 진짜 Claude Code 스킬·서브에이전트·슬래시커맨드·CLAUDE.md·hooks (`~/.claude` + 프로젝트 `.claude/`) | **dev 엔진 전용** (`ClaudeAgentSdkEngine`) | 앱 밖에서 파일을 편집해야 한다 | `src/engines/claude-agent-sdk-engine.ts` — `settingSources: ['user','project','local']`, 빌트인 툴을 켠 상태로 둔다 |
| **B. 셸 슬래시 팔레트** (`/plan /qa /ap /fx /ex /go` 등) | cockpit 포크에 **하드코딩된** 프롬프트 템플릿 | 모든 엔진 | **없다. 전부 하드코딩이다** | `shell/.../server/api/commands.ts`(BUILTIN_COMMANDS), `.../server/lib/slashCommands.ts`, `client/ChatInput.tsx`(`/plan`) |

- **평면 A는 물려받은 것이지 소유한 것이 아니다.** dev 엔진은 사실상 맨 `claude` CLI와 같은 하네스로 돈다. 격리를 담당하는 것은 툴 목록이 아니라 **PreToolUse 게이트** 하나이고, 기본값 `gate.allowChanges=ON`은 allow-all이다. `src/runtime/gate.ts`의 `phase1HarnessFloor`는 토글을 껐을 때만 읽기 전용 바닥이 된다.
- **평면 B는 하드코딩이다.** `source:"builtin"`이라 "기본 제공" 배지가 붙는다. 추가·삭제·import·export **어느 것도 없다.** `~/.cockpit/skills.json` 경로가 흔적으로 남아 있지만 앱에서 **쓸 수 없고**(손으로 편집해야 한다) 팔레트에도 뜨지 않는다.
- **prod `AiSdkEngine`(프로바이더 5개)에는 하네스 개념이 전혀 없다.** system prompt와 실행기 없는 툴, MCP뿐이다(`src/engines/ai-sdk-engine.ts`).
- **스펙에도 하네스 이식성·스킬 관리·서브에이전트 관리 계획이 없다.** 기존 "import/export"는 전부 `~/.cockpit/projects.json` 프로젝트 임포트를 말한다.

### 1.1 결정적 문제 — dev와 prod 사이의 절벽

dev(Claude) 엔진에서는 풍부한 하네스를 물려받는데, **prod(Azure·Gemini·OpenAI) 엔진으로 바꾸는 순간 스킬과 서브에이전트와 커맨드가 전부 사라진다.** 개인화 전략이 경계한 "계기판만 있고 조향장치가 없는" 상태가 하네스에서도 그대로 벌어진다. "dev에서 되던 게 prod에서 안 된다"가 하네스 차원에서 반복된다. Naby Layer 설계(§3.6)가 프로바이더 네이티브 스토어(`~/.claude`)를 **엔진 아래로** 밀어 둔 것은 세션과 메모리에는 맞는 선택이지만, 하네스를 그 아래 두면 이식성이 아예 막힌다.

### 1.2 문제 정의

> **"하네스는 지금 Claude Code에서 빌려 쓰는 상속물이거나(dev 전용) 손댈 수 없는 하드코딩이다. 내가 만들고, 팀과 나누고, 어느 프로바이더에서도 쓰는 자산이 되려면 Naby Layer가 하네스를 1급 엔티티로 소유해야 한다."**

---

## 2. 개념 — 하네스를 Naby가 소유하는 이식 자산으로

> **"내가 조립한 스킬·서브에이전트·커맨드는 모델을 바꿔도, 기기를 바꿔도, 동료에게 건네도 그대로 작동하는 내 것이다."**

프로젝트와 세션과 메모리를 Naby Layer 소유로 만든 **v0.7 realignment를 하네스까지 넓히는 일**이다. 소유 엔티티 목록에 **Harness**가 더해진다: *Projects · Sessions · Agents · Context · Memory · **Harness***.

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

## 3. 설계 결정 여섯 가지 (권고안 포함)

실행 문서가 확정할 결정이다. 권고는 달아 두고, 진짜 갈림길은 §6 open question으로 남긴다.

- **D1 · Naby Layer가 하네스를 소유한다** *(권고: 채택)* — 스킬·서브에이전트·커맨드와 **하네스 셋**(이름 붙인 번들)을 `app.db`에 프로바이더와 무관하게 저장한다. 메모리처럼 스코프(user/project/org)를 둘 수 있다.
- **D2 · 교환 포맷은 Claude Code 아티팩트를 채택하고 감싼다** *(권고: adopt-and-wrap)* — SKILL.md, 서브에이전트 `.md`(frontmatter), 커맨드 `.md`를 그대로 import·export 포맷으로 쓴다. 이유는 세 가지다. `~/.claude`와 동료가 이미 가진 Claude Code 셋을 **공짜로 임포트**할 수 있고, 사실상 표준이며, export가 이식성을 지켜 준다. Naby 모델이 이 포맷을 감싼다.
- **D3 · 프로바이더 독립 하네스 런타임을 만든다** *(권고: 단계적으로)* — prod 엔진에는 하네스 런타임이 없으니 Naby가 직접 만든다. 조각마다 난이도가 다르다.
  - **커맨드**는 프롬프트 확장이라 평면 B가 이미 하는 방식이다. **프로바이더 독립을 곧바로 이룰 수 있다**(가장 싼 승리).
  - **스킬**은 트리거가 걸리면 SKILL.md를 주입하고 필요하면 툴을 붙인다. Naby가 로딩과 점진적 공개를 직접 하면 독립한다. 난이도는 중간이다.
  - **서브에이전트**는 자체 시스템 프롬프트·툴·모델을 가진 하위 컨텍스트를 띄운다. **Naby 런타임이 서브에이전트 오케스트레이션을 직접 구현해야 한다**(AI SDK는 제공하지 않는다). 가장 큰 작업이고 Phase 2의 루프 소유와 겹친다.
- **D4 · dev에서 물려받는 하네스는 런타임이 아니라 IMPORT 소스로 내린다** *(권고: import-then-own)* — 지금은 SDK가 `~/.claude`를 직접 읽는다. 이를 **Naby 스토어로 한 번 임포트한 뒤 자체 런타임으로 실행**해 엔진마다 다르게 동작하는 일을 없앤다. `projects.json` 일회 임포트와 메모리 realignment에서 쓴 패턴이다.
- **D5 · 팀 공유는 하네스 셋을 export하고 import하는 것이다** *(권고: 번들 포맷)* — 사내 배포의 강점이다. "하네스 셋"은 스킬과 서브에이전트와 커맨드에 매니페스트를 더해 이름과 버전을 붙인 번들이다. export는 파일이나 폴더로 내보내고(서명할 수 있다), import는 충돌을 처리하며 병합한다. **org 스코프 하네스**는 org 스코프 메모리의 자매다.
- **D6 · 임포트한 하네스는 신뢰할 수 없는 콘텐츠다** *(권고: 게이트 + provenance + 검토 후 활성)* — 동료의 스킬과 서브에이전트에는 프롬프트 인젝션이나 위험한 툴 사용이 숨어 있을 수 있다. 메모리 오염(ASI06, [`personalization-strategy`](personalization-strategy.md) §7.1)과 같은 위협이다. 임포트한 항목은 **기본으로 꺼 두고**, provenance를 기록하고, 게이트를 반드시 통과시키고, 켜기 전에 사람이 검토한다. [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md) §4 쓰기 게이트의 신뢰 등급 모델을 하네스에도 적용한다.

---

## 4. 사용자가 하려던 일과 그에 답하는 결정

| 오너가 물은 것 | 답하는 결정 | 결과 |
|---|---|---|
| 이 커맨드들을 추가·삭제하고 싶다 | D1 소유 + D3(커맨드) | 팔레트가 하드코딩에서 손댈 수 있는 자산으로 바뀐다 |
| 사내 다른 사람이 만든 하네스를 가져오고 싶다 | D2 포맷 + D5 셋 + D6 게이트 | 동료 번들을 검토한 뒤 병합한다 |
| 내 하네스 셋을 내보내고 싶다 | D1 + D5 | 이름과 버전을 붙인 번들로 내보낸다 |
| 특정 스킬만 내 Naby로 가져오고 싶다 | D2 + D5(선택 병합) | 번들에서 항목 단위로 임포트한다 |
| 서브에이전트를 추가하고 싶다 | D1 + D3(서브에이전트) | Naby 자체 오케스트레이션 위에 등록한다 |

---

## 5. Phase 배치와 태스크 제안

**v0.2에서 다시 판단한 것** — 하네스 이식성의 *대부분*은 Phase 2에 의존하지 않는다. 원래 Phase 2.5로 미뤄 둔 이유는 **가장 무거운 조각(HP-07, 툴을 쓰는 서브에이전트) 하나에 맞춰 phase를 잡은 지나친 보수**였다. 실제 의존성은 태스크마다 다르다.

- **Phase 2와 무관한 것** — HP-01(스키마), HP-02(커맨드 CRUD), HP-04(`~/.claude` 임포터), HP-05(셋 export/import), HP-06(임포트 게이트), HP-08(org 상속)은 전부 **store와 프롬프트 주입, import/export, 신뢰 게이트**로 끝난다. 커맨드와 스킬 지시문 주입은 메모리 주입(P15-02)과 **같은 메커니즘**(엔진 seam 위에서 system을 조립한다)이라 엔진 5개에서 곧바로 돈다. HP-06은 **Phase 1.5의 쓰기 게이트와 provenance를 그대로 재사용한다**(이미 구현했다).
- **Phase 2에 의존하는 것** — 툴을 *실행하는* 조각뿐이다. HP-03의 **툴을 동반한 스킬**과 HP-07의 **툴을 쓰는 서브에이전트 오케스트레이션**은 Phase 2의 툴 실행기와 게이트가 있어야 한다.

**그래서 하네스 코어를 Phase 2보다 앞으로 당겨 `Phase 1.6`으로 둔다.** 메모리를 1.5 코어와 2b 추출 루프로 쪼갠 것과 같은 패턴이다.

**Phase 1.6 — Harness Ownership (Phase 2보다 먼저)**

| ID | 항목 | 완료 기준 | 난이도 |
|---|---|---|---|
| HP-01 | 하네스 소유 스키마 (commands·skills·subagents·sets + provenance·enabled·scope) | 세션이나 프로젝트를 지워도 하네스가 지워지지 않는다. user·org 스코프가 있다 | S–M |
| HP-02 | 커맨드 CRUD와 프로바이더 독립 확장 | 하드코딩 팔레트에 사용자가 추가·삭제할 수 있다. 엔진 5개에서 같게 확장된다 | S |
| HP-03a | 스킬 런타임 — **지시문 주입만**(자체 로딩·점진적 공개) | 지시문 스킬이 dev와 prod에서 같은 조건으로 트리거되고 주입된다(툴 없는 스킬) | M |
| HP-04 | `~/.claude`와 `.claude/` 임포터 (D4) | 기존 Claude Code 커맨드·스킬·서브에이전트를 손실 없이 Naby 스토어로 가져온다 | M |
| HP-05 | 하네스 셋 export/import와 병합·충돌 처리 (D5) | 번들을 내보내 다른 기기나 동료가 임포트한다. 항목 단위로 고를 수 있다 | M |
| HP-06 | 임포트 게이트 + provenance + 검토 UI (D6) | 임포트한 항목은 기본으로 꺼져 있다. 외부에서 온 것은 검토 전에 실행되지 않는다. 오염 페이로드 음성 테스트를 통과한다(**Phase 1.5 게이트 재사용**) | S–M |
| HP-08 | org 스코프 하네스 상속 (팀 페르소나) | 새 사용자가 조직 하네스 셋을 기본으로 물려받는다 | M |

**Phase 2.5 — Harness Execution (Phase 2와 함께 또는 그 뒤 — 툴 실행기에 의존한다)**

| ID | 항목 | 완료 기준 | 난이도 |
|---|---|---|---|
| HP-03b | 툴을 동반한 스킬 | 스킬이 참조하는 툴이 Phase 2 게이트 아래에서 실행된다 | M |
| HP-07 | 서브에이전트 오케스트레이션 (프로바이더 독립) | Naby 런타임이 서브에이전트를 띄우고 게이트를 걸고 관찰한다. 엔진 5개에서 동작한다 | **L** |

- **가장 싼 첫 승리는 HP-02(커맨드)다.** 하드코딩 팔레트가 손댈 수 있는 것으로 바뀌고 프로바이더 5개에서 같게 동작한다. dev와 prod 사이 절벽의 첫 조각을 바로 메우고, 오너가 처음 물은 "이 커맨드를 추가·삭제하고 싶다"에 가장 직접 답한다.
- **왜 Phase 1.6인가.** 첫째, dev와 prod의 절벽은 *지금* 겪는 문제다(Phase 1을 끝낸 상태에서 이미 벌어진다). 둘째, Phase 1.5와 같은 store·gate 패턴이라 방금 만든 쓰기 게이트와 provenance를 재사용한다. 셋째, 팀 공유(HP-05·HP-08)는 사내 배포의 강점인데 Phase 2에 의존하지 않는다.

---

## 6. Open questions (실행 문서로 넘긴다)

- ~~**Phase 경계**~~ — **해소했다(v0.2).** 하네스 코어(HP-01/02/03a/04/05/06/08)는 Phase 2에 의존하지 않으므로 **Phase 1.6으로 당겼다.** 툴 실행에 의존하는 조각(HP-03b/07)만 **Phase 2.5**로 나눴다. §5를 참조한다. 실행 문서는 [`phase-1_6-harness-ownership`](../impl/phase-1_6-harness-ownership.md)(impl)과 [`phase-1_6-harness-contracts`](../interface/phase-1_6-harness-contracts.md)(interface)다.
- **자체 포맷이냐 Claude Code 포맷이냐** — D2는 채택하고 감싸는 쪽을 권한다. 다만 Naby만의 능력(여러 프로바이더에서 모델 지정, 메모리 연동)을 표현하려면 확장 필드가 필요하다. 확장을 어디까지 둘지 정해야 한다.
- **서브에이전트의 프로바이더 독립성** — 서브에이전트가 부모와 다른 프로바이더나 모델로 돌 수 있어야 하는가? 여러 프로바이더를 쓰는 실질 이점이지만 복잡도가 크게 올라간다.
- **hooks 이식** — Claude Code hooks까지 옮길 대상인가, 아니면 Naby 게이트와 이벤트로 흡수하고 이식 범위에서 뺄 것인가. 보안상 hooks 임포트는 임의 코드 실행 위험이 있다.
- **SKILL.md 실행 호환** — 임포트한 스킬이 참조하는 툴이 Naby 툴셋에 없을 때 어떻게 할지(스텁, 비활성, 경고).
- **셋 서명과 신뢰 체계** — 사내 배포에서 org 하네스 셋의 출처를 어떻게 보증하고(서명) 어떤 채널로 배포할지.

---

## 7. 참고

- 자매 전략: [`personalization-strategy`](personalization-strategy.md) — 기억의 소유권과 이식성을 다룬다. 하네스는 같은 명제의 다른 축이다.
- 소유 모델: [`personalized-agent-desktop-app`](personalized-agent-desktop-app.md) §3.6 — Naby Layer가 projects·sessions·memory·context를 소유한다. 여기에 harness가 합류한다.
- 오염 방어 모델 재사용: [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md) §4 — 신뢰 등급, provenance, 검토 후 활성.
- 하네스가 무엇을 할 수 있는지의 통제: [`phase-2-personalization-hitl`](../impl/phase-2-personalization-hitl.md) — 게이트와 가드레일. 이식성은 *무엇을 가지느냐*이고 게이트는 *무엇을 하게 두느냐*다. 둘은 서로 독립이다.
