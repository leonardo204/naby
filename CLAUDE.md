# Claude Code 개발 가이드

> 공통 규칙(Agent Delegation, 커밋 정책, Context DB 등)은 글로벌 설정(`~/.claude/CLAUDE.md`)을 따릅니다.
> 글로벌 미설치 시: `curl -fsSL https://raw.githubusercontent.com/leonardo204/dotclaude/main/install.sh | bash`

---

## Slim 정책

이 파일은 **100줄 이하**를 유지한다. 새 지침 추가 시:
1. 매 턴 참조 필요 → 이 파일에 1줄 추가
2. 상세/예시/테이블 → ref-docs/*.md에 작성 후 여기서 참조
3. ref-docs 헤더: `# 제목 — 한 줄 설명` (모델이 첫 줄만 보고 필요 여부 판단)

---

## PROJECT

### 개요

**naby** — 나를 학습해 나를 대리하는 개인 페르소나 에이전트 데스크톱 앱. 기억과 하네스를 벤더 밖 내 자산으로 둔다.

| 항목 | 값 |
|------|-----|
| 기술 스택 | TypeScript · Electron · Next.js 16 셸 · SQLite(`node:sqlite`) · Effect · ai-sdk와 Claude Agent SDK 두 엔진 |
| 구조 | **런타임**(`src/`, 프로바이더 독립 코어)과 **셸**(`shell/`, cockpit submodule) 2레이어. 데이터는 `app.db` 하나 |
| 빌드 | `npm run build:app`(runtime → shell → electron). 실행은 `npm run electron:dev` |
| 검증 | 셸 테스트 `cd shell && npm test` · 타입체크 `npm run typecheck`(양 트리) · 스파이크 `npm run spike:<name>` |
| DB 경로 | `NABY_DB_PATH` > `NABY_HOME` > `~/.naby/app.db` |
| 상태 | 개발 중. Phase 3(페르소나 에이전트) P3-M3까지 완료, P3-M4(학습) 남음 |

### 어느 레이어에 쓰는가

판단 기준은 하나다. **프로바이더나 UI를 바꿔도 남아야 하는 것은 런타임(`src/`)에 쓴다.**

- **런타임** — 스토어 스키마와 드라이버, 게이트와 정책, 메모리·스킬 주입, 에이전트 모델, 순수 파서. 검증은 `src/spikes/spike-*.ts`로 한다.
- **셸**(`shell/`) — HTTP 액션(`api/naby.ts`), 엔진 어댑터(`engines/naby.ts`), 외부 채널(`lib/telegram*.ts`), React UI, i18n. 검증은 vitest로 한다.
- 셸은 별도 저장소(cockpit) submodule이다. **양쪽을 각각 커밋하고**, naby 커밋이 셸 포인터를 함께 옮긴다.

### 검증할 때 주의

- 셸 API(`/api/naby`)는 **dev 서버에서 500이 난다.** turbopack이 `node:sqlite`를 외부화하지 못한다. 반드시 prod 빌드 서버(`node server.mjs`, distDir `.next-prod`)로 확인한다.
- 엔진 턴 루프를 고쳤으면 `npm run spike:autonomy`와 `npm run spike:02`를 먼저 돌린다. mock 모델로 실제 엔진·게이트·실행기를 구동해 회귀를 잡는다.
- 스파이크는 `NABY_DB_PATH`를 임시 디렉터리로 돌린다. 실제 `~/.naby/app.db`를 건드리지 않는다.

### 스펙 문서 지도

스펙 트리가 **둘**이다. 의도된 분리이며 규칙은 이렇다.

- `ref-docs/specs/` — **정본.** `sdd.md`의 `{DOC_ROOT}`가 `ref-docs/`이므로 형식상 기준이다. `design|impl|interface|test` 계층을 지킨다. 전략·계약·완료된 Phase가 여기 있다.
- `specs/` — **진행 중 착수 스펙.** 평면 구조를 허용하되 **frontmatter는 필수**다(id/type/version/status/scope/related/updated). 영향도 추적이 끊기면 트리를 나눈 이점이 사라진다. 안정되면 `ref-docs/specs/<type>/`으로 승격한다.
- 현재 `specs/`: [페르소나 에이전트](specs/phase-3-persona-agent.md) · [나비 신뢰 지표](specs/phase-3-butterfly-trust-meter.md) · [체크인 원장 계약](specs/phase-3-checkin-contracts.md) · [에이전트 내보내기](specs/phase-3-agent-export.md) · [Phase 2/2.5 계획](specs/phase-2-2.5-plan.md)
- 새 스펙을 쓰거나 받았으면 `/spec-guard`로 기존 문서와 대조한다. **스펙을 저장하는 행위 자체가 발동 조건이다.**

### 문서 구조 (소유권 분리)

- **하니스 문서** (`claude/` 하위) — 🔒 dotclaude 소유. `dotclaude-update`가 덮어쓰니 **수정 금지**.
- **프로젝트 스펙** (`specs/` 하위) — 📝 자유롭게 작성. → [SDD 가이드라인](ref-docs/claude/sdd.md) · `/spec-guard`로 정합성 분석

### 하니스 상세 문서 (claude/)

- [Context DB](ref-docs/claude/context-db.md) — SQLite 기반 세션/태스크/결정 저장소
- [Context Monitor](ref-docs/claude/context-monitor.md) — HUD + compaction 감지/복구
- [Hooks](ref-docs/claude/hooks.md) — 5개 자동 실행 Hook 상세
- [컨벤션](ref-docs/claude/conventions.md) — 커밋, 주석, 로깅 규칙
- [셋업](ref-docs/claude/setup.md) — 새 환경 초기 설정
- [Agent Delegation](ref-docs/claude/agent-delegation.md) — 에이전트 위임/파이프라인 상세
- [SDD 가이드라인](ref-docs/claude/sdd.md) — 스펙 문서 작성/관리 규약

> 프로젝트 스펙은 `specs/`에 작성하고, 하니스 문서(`claude/`)는 건드리지 마세요.

### 핵심 규칙

- **코드 안은 영어로 쓴다.** 커밋 메시지, 주석, 로그 출력 모두 영어다. 한국어는 UI 문구 같은 인용 리터럴에만 쓴다.
- **한국어 문서는 `/plain-korean-doc` 스킬을 거쳐 낸다.** 어미는 `~한다` 평서형으로 통일한다(`specs/`, `ref-docs/specs/` 전체 기준).
- 하네스 문서(`ref-docs/claude/`)는 dotclaude 소유라 수정하지 않는다. 프로젝트 스펙은 `specs/`에 쓴다.

---

*최종 업데이트: 2026-07-25*
