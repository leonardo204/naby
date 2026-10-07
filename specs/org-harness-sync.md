---
id: org-harness-sync
title: 조직 하네스 동기화 — altimedia-harness를 naby 기본 하네스로 따라간다
type: design
version: 0.5.0
status: draft
scope: Skill Hub의 altimedia-harness 플러그인을 naby의 조직 하네스로 받아 와 자동 갱신하고, 스킬·훅·집계·인증 차단을 두 엔진에서 같은 동작으로 실행한다. 기존 사용자가 앱을 업그레이드할 때 끊김 없이 넘어오는 이전 계획을 포함한다. 플러그인 형식 일반 지원(임의 마켓플레이스)은 범위 밖이다.
related: [skill-hub-builtin, harness-standalone, phase-1_6-harness-contracts, phase-1_6-harness-ownership, packaging-path-resolution]
updated: 2026-10-07
---

# 조직 하네스 동기화 — altimedia-harness를 naby 기본 하네스로 따라간다

사내 공통 AI 하네스(altimedia-harness)를 naby에서도 쓴다. Claude Code에 플러그인으로 설치한 것과 같은 스킬·훅·집계가 naby의 두 엔진(Claude Agent SDK, ai-sdk)에서 같은 동작으로 돈다. Skill Hub에서 새 버전이 나오면 naby도 따라간다.

## 1. 결정 사항 (사용자 결정, 2026-10-07)

| 항목 | 결정 |
|---|---|
| 갱신 | Skill Hub 버전이 바뀌면 naby 하네스도 자동으로 갱신한다 |
| 집계 | naby 사용분도 사내 적용률(H1~H4)에 잡힌다 |
| 인증 차단 | Atlassian 인증 전에는 naby에서도 프롬프트를 막는다 |
| 스킬 훅 | task·ctx의 훅을 naby에서 실행한다 |
| 세션 종료 | 탭 닫기와 앱 종료를 세션 종료로 본다 |
| 인증 유예 | 기존 사용자는 업그레이드 후 7일 동안 막지 않는다 |
| 같은 이름 사본 | 자동으로 끄지 않는다. 알림을 띄우고 사용자가 고른다 |
| naby 사용분 구분 | 집계에서 naby를 따로 센다. Skill Hub 쪽 변경과 함께 간다(§3.7, 부록 A) |
| Atlassian | 공식 원격 MCP의 브라우저 OAuth **하나로 통일**한다. API 토큰 방식(`mcp-atlassian`)은 없앤다(§3.8, §4.4) |

## 2. 지금 naby와의 차이

altimedia-harness 0.7.1을 직접 열어 확인한 내용이다(`~/.claude/plugins/cache/altimedia-skills/altimedia-harness/0.7.1`).

| 플러그인 구성 | naby 현황 | 차이 |
|---|---|---|
| MCP `skill-hub`·`cic` | 시스템 MCP 프리셋에 같은 주소로 있다(skill-hub-builtin §2.1, §2.7) | 없음 |
| MCP `atlassian` | 플러그인은 공식 원격 MCP(`https://mcp.atlassian.com/v1/mcp`, 브라우저 OAuth)다. naby 프리셋은 `mcp-atlassian` stdio(API 토큰)다 | 서버 종류와 도구 이름이 다르다. pdoc 0.12.0은 공식 MCP의 도구(`getConfluencePage`, `searchConfluenceUsingCql`, `createConfluencePage`)를 기본으로 부른다. naby의 `atlassian` 프리셋을 OAuth로 바꾼다(§3.8) |
| 스킬 task·pdoc·ctx | 없다 | 크기와 파일 구성이 naby 스킬 모델과 맞지 않는다(아래) |
| 훅 7종 | 훅 개념이 없다. 가져오기는 훅을 세기만 하고 실행하지 않는다(phase-1_6 계약 §4) | 실행기가 필요하다 |
| 버전 따라가기 | 내장 번들은 없을 때만 만들고 본문을 덮어쓰지 않는다(skill-hub-builtin §2.7) | 갱신 경로가 필요하다 |

**스킬 크기.** `SKILL.md`만 pdoc 84KB, ctx 33KB, task 24KB다. naby는 스킬 본문을 턴마다 시스템 프롬프트에 넣고 그 상한이 3000토큰이다(`skill-inject.ts`). 셋 중 어느 것도 들어가지 않는다. Claude Code는 이름과 설명만 늘 보여 주고 본문은 부를 때 읽는다. naby에도 이 방식이 필요하다(§3.3).

**파일 묶음.** 세 스킬은 파일을 10~68개 가진다. Python 스크립트, 참고 문서, 템플릿이고, 본문이 상대 경로로 가리킨다. naby 스킬은 파일이 아니라 `harness_items`의 행이라 이 경로가 존재하지 않는다. 패키지를 디스크에 풀어 두어야 한다(§3.1).

**Claude Code 전제.** 본문과 훅이 `Bash`·`Write`·`Edit` 도구 이름, `${CLAUDE_PLUGIN_ROOT}`·`${CLAUDE_SKILL_DIR}`·`CLAUDE_PROJECT_DIR` 환경 변수, `.claude/` 경로를 쓴다. 0.8.x 본문은 스크립트를 `${CLAUDE_SKILL_DIR}`(스킬 폴더) 기준으로 부르고, `${CLAUDE_PLUGIN_ROOT}`는 주로 훅이 쓴다. 자동 갱신되는 본문은 naby가 손으로 고칠 수 없다(내장 번들과 다른 점). 고치는 대신 호환 계층을 둔다(§3.4).

## 3. 설계

### 3.1 패키지를 받아 온다

출처는 Skill Hub 마켓플레이스 하나다.

- 목록: `GET https://skills.altimedia.com/api/v1/marketplace.json`에서 `plugins[name=altimedia-harness]`의 `version`, `source.url`, `source.sha256`을 읽는다.
- 본체: `source.url`(`/api/v1/plugins/altimedia-harness/download`)에서 zip을 받는다. 인증 없이 받아진다(사내망에서 확인, 200, 473,035바이트).
- **sha256이 마켓플레이스 값과 다르면 버린다.** 받은 것을 쓰지 않고, 이전 버전을 그대로 둔다.
- 이 확인은 **서명이 아니라 무결성 확인**이다. 목록과 zip이 같은 서버에서 오므로, 전송 중 손상과 반쯤 받은 파일은 막지만 서버 자체가 뚫린 경우는 막지 못한다. 신뢰의 기준은 `skills.altimedia.com`(HTTPS, 사내망)이다. Claude Code에 같은 플러그인을 설치할 때와 같은 수준이다. 서명은 Skill Hub가 서명 키를 내놓으면 더한다(§6).
- 푸는 곳은 `~/.naby/org/altimedia-harness/<version>/`이다. 다 풀린 뒤에 `current` 표시를 새 버전으로 옮긴다. 도중에 끊겨도 이전 버전이 계속 쓰인다. 직전 버전 하나는 남기고 그보다 오래된 것은 지운다.
- 확인 시점은 앱 시작과 그 뒤 6시간마다다. Skill Hub는 스킬이 바뀌면 5분 안에 다시 조립하므로, 하루 안에는 반영된다.
- 사내망 밖이거나 서버가 응답하지 않으면 조용히 다음 확인을 기다린다. 이미 받은 버전은 계속 동작한다. 받은 버전이 하나도 없는 첫 실행이면 조직 하네스 없이 동작하고, 설정 화면에 "사내망에 연결되면 받는다"를 표시한다. 인증 차단(§3.6)도 패키지가 없으면 걸지 않는다.
- 런타임에서 경로를 찾을 때는 `NABY_HOME` 기준으로 정한다. 앱 번들 안 경로를 쓰지 않으므로 packaging-path-resolution의 `import.meta.url` 문제와 무관하다.

### 3.2 행으로 반영한다

받은 스킬을 `harness_items`에 넣는다.

- 범위(scope)는 `org`, 출처(origin)는 `org:altimedia-harness@<version>`이다. 신뢰 등급(`TrustTier`: user·artifact·external)에는 새 값을 더하지 않는다. 그 타입은 기억과 함께 쓰므로, 조직 항목은 범위 `org`와 검증된 출처로 구분한다.
- **조직 하네스는 켜진 채로 들어온다.** sha256 확인을 거친 Skill Hub 패키지만 해당한다. phase-1_6 계약 §7의 미결 질문("서명된 조직 세트가 켜진 채 도착할 수 있나")에 대한 답이다.
- **사용자가 끈 것은 다시 켜지 않는다.** 내장 번들의 `autoStatus` 규칙(skill-hub-builtin §2.7)을 그대로 쓴다. 키는 `harness.org.<name>.autoStatus`다.
- 행의 `payload.skill`에는 본문을 넣지 않는다. `instructions`는 description 한 단락, `toolRefs`는 `["naby_skill_load", "run_command"]`, 새 필드 `loadMode: "on-demand"`와 `packageRef: "altimedia-harness"`를 둔다. 본문은 패키지 파일에서 읽는다. 이 모양이면 이 기능을 모르는 이전 버전 앱은 `naby_skill_load` 도구가 없어 이 행을 주입하지 않고 `excludedForTools`로 세기만 한다(§4.7).
- 갱신하면 본문과 파일을 새 버전으로 바꾼다. 조직 스킬은 UI에서 읽기 전용이다. 고치고 싶으면 user 범위로 복제해서 고친다. 이름이 같으면 기존 범위 순위(project > user > org, `skill-inject.ts`의 `SCOPE_RANK`)대로 복제본이 조직 것을 가린다.
- 새 버전에서 빠진 스킬은 행을 `removed`로 바꾸고 출처에 `org-withdrawn`을 남긴다. 사용자가 지운 묘비와 구분해서, 다시 들어오면 되살아날 수 있게 한다.

### 3.3 스킬을 필요할 때 불러온다

조직 스킬은 `load: on-demand` 모드로 둔다. 기존 내장 스킬의 주입 방식은 바꾸지 않는다.

- 턴마다 시스템 프롬프트에는 **이름과 description만** 넣는다. 세 스킬의 description 합이 약 770자(약 700토큰)라 기존 예산 안에 들어간다. 이 목록은 본문 예산과 따로 센다.
- 모델은 도구 `naby_skill_load(name)`로 본문을 받는다. 결과는 본문, §3.4의 호환 안내, 스킬 폴더의 절대 경로다.
- 사용자가 `/task start`처럼 스킬 이름을 직접 쓰면(`explicitNames`) 그 턴에 본문을 미리 불러 둔다.
- 스킬 폴더 안의 참고 파일은 기존 `read_file`로 읽는다. 게이트는 `~/.naby/org/` 아래 읽기를 허용한다. 쓰기는 허용하지 않는다.
- 세 스킬은 Python 스크립트를 실행하므로 `run_command`를 요구한다. 셸이 없는 턴(프로젝트를 열지 않은 세션)에서는 목록에서 빼고 `excludedForTools`로 센다. 기존 규칙과 같다.

### 3.4 Claude Code 호환 계층

본문을 고치지 않고, 불러올 때와 실행할 때 차이를 메운다.

**본문을 불러올 때.** `naby_skill_load` 결과 앞에 고정 안내문을 붙인다.

| 본문 표기 | naby에서 쓰는 것 |
|---|---|
| `Bash` | `run_command` |
| `Read` / `Write` / `Edit` | `read_file` / `write_file` / `edit_file` |
| `AskUserQuestion` | 답변 본문으로 묻는다. 되돌리기 어려운 선택은 `naby_checkin`으로 묻는다 |
| `${CLAUDE_PLUGIN_ROOT}` | 이 패키지의 절대 경로(불러올 때 문자열로 바꿔 넣는다) |
| `${CLAUDE_SKILL_DIR}` | 그 스킬 폴더의 절대 경로(불러올 때 문자열로 바꿔 넣는다) |
| `.claude/` | 프로젝트 저장소 안의 파일이면 그대로 쓴다. `~/.claude/` 사용자 설정은 건드리지 않는다 |

**명령을 실행할 때.** 스킬 폴더 아래 스크립트를 실행하는 `run_command`에는 `CLAUDE_PLUGIN_ROOT`, `CLAUDE_SKILL_DIR`, `CLAUDE_PROJECT_DIR`(열린 프로젝트), `HARNESS_CLIENT=naby`, `CLAUDE_PLUGIN_OPTION_CIC_TOKEN`(설정된 경우)을 넣는다. skill-hub API 키는 넣지 않는다. 스크립트가 쓰지 않는 값이다.

Claude 엔진이 SDK 내장 `Bash`·`Write`·`Edit`를 쓰는 경우에도 이 계층은 같다. 이름 표가 항등 변환이 될 뿐이다.

### 3.5 훅 실행기

런타임(`src/`)에 Claude Code 훅 규격과 호환되는 실행기를 둔다. 두 엔진이 같은 실행기를 부른다.

**실행하는 훅과 실행하지 않는 훅.** 패키지의 `hooks/hooks.json`을 읽되, 명령 대상 스크립트가 **허용 목록**에 있는 것만 실행한다.

| 스크립트 | 처리 | 이유 |
|---|---|---|
| `scripts/run-skill-hook.js` (task·ctx 훅) | 실행한다 | 프로젝트 파일만 다룬다 |
| `scripts/metrics-emit.js` (H1~H4) | 실행한다 | 이벤트만 보낸다. 단계 판정 규칙을 Skill Hub가 계속 소유한다 |
| `scripts/activate.js` | 실행하지 않고 naby가 구현한다(§3.6) | `~/.claude/settings.json`의 `enabledPlugins`와 훅을 직접 고친다 |
| `scripts/gate.js` | 실행하지 않고 naby가 구현한다(§3.6) | Claude Code 자격 증명 저장소를 읽는다 |
| `scripts/deps-check.js` | 실행하지 않고 naby가 구현한다(§3.6) | 안내를 Claude Code 화면 형식으로 낸다 |
| 그 밖의 새 스크립트 | 실행하지 않는다. 설정 화면에 "naby가 아직 지원하지 않는 훅"으로 표시한다 | 새 훅은 naby 릴리스에서 검토한 뒤 허용 목록에 넣는다 |

훅은 **sha256을 확인한 조직 패키지에서만** 실행한다. 사용자가 `~/.claude`에서 가져온 훅이나 하네스 세트에 든 훅은 지금처럼 세기만 한다(phase-1_6 계약 §4를 이 범위만큼 좁혀 개정한다).

**시점 대응.**

| Claude Code 이벤트 | naby 시점 |
|---|---|
| `SessionStart` | 세션의 첫 턴 직전. compact 뒤 재시작이면 `source: "compact"` |
| `UserPromptSubmit` | 사용자 메시지를 받고 엔진에 넘기기 전 |
| `PreToolUse` | 게이트가 도구 호출을 판정하기 직전 |
| `PostToolUse` | 도구가 끝난 뒤 |
| `Stop` | 턴이 끝났을 때 |
| `PreCompact` | `compaction.ts`가 줄이기 직전, Claude 엔진은 `compact_boundary` 직전 |
| `SessionEnd` | 탭 닫기, 앱 종료 |

**matcher.** `hooks.json`의 `matcher`는 Claude Code와 같이 **정규식**으로 해석한다. 0.8.0부터 `^mcp__.*__(confluence_(create\|update)_page\|(create\|update)ConfluencePage)$` 같은 식이 들어 있다. 비교 대상은 아래 입력 절의 변환을 마친 Claude Code 철자의 도구 이름이다. 정규식이 잘못됐으면 그 훅 항목만 건너뛰고 로그에 남긴다.

**입력.** 표준 입력에 JSON을 준다. 필드는 `session_id`, `cwd`(열린 프로젝트), `hook_event_name`, `transcript_path`, 도구 이벤트면 `tool_name`·`tool_input`, 서브에이전트 안이면 `agent_id`다.

- `tool_name`과 `tool_input`은 Claude Code 형식으로 바꾼다. `run_command` → `Bash`(`command`), `write_file` → `Write`(`file_path`), `edit_file` → `Edit`(`file_path`)다. MCP 도구는 `mcp__<server>__<tool>` 철자로 넘긴다. 이 변환이 빠지면 훅이 오류 없이 아무것도 하지 않으므로, 스파이크가 표 전체를 검사한다.
- `transcript_path`는 그 세션을 Claude Code 형식 JSONL로 내보낸 파일 경로다(`~/.naby/transcripts/<session>.jsonl`). `PreCompact`와 `SessionEnd` 때 새로 쓴다.

**실행.** `node`로 시작하는 명령은 앱 자신의 실행 파일을 `ELECTRON_RUN_AS_NODE=1`로 띄워 실행한다. 사용자 PC에 Node.js가 없어도 된다. Python은 사용자 PC의 것을 쓴다(`run-skill-hook.js`가 찾는다). 환경 변수는 §3.4와 같다.

**출력 처리.**

| 출력 | 처리 |
|---|---|
| `hookSpecificOutput.additionalContext` | 그 턴의 시스템 프롬프트에 붙인다 |
| `permissionDecision: "ask"` | naby 승인 UI로 보낸다. 사유 문구를 그대로 보여 준다 |
| `permissionDecision: "deny"` | 게이트가 거부한다 |
| `async: true` | 기다리지 않는다 |
| 시간 초과, 실행 실패, 0이 아닌 종료 코드 | 무시하고 턴을 계속한다. 훅 로그에만 남긴다 |

탭이 여러 개면 훅도 세션마다 따로 돈다. ctx 재색인처럼 같은 프로젝트 파일을 쓰는 훅이 겹치지 않도록, 실행기는 `PreCompact`·`SessionEnd` 훅을 프로젝트(`cwd`)마다 한 번에 하나씩만 돌린다. 나머지 훅은 읽기 위주라 동시에 돌린다.

Windows에서는 Python을 `py -3`까지 찾고(`run-skill-hook.js`가 이미 그렇게 한다), `ELECTRON_RUN_AS_NODE`로 띄우는 경로를 Windows 패키징본에서 따로 확인한다.

`SessionEnd`는 앱 종료를 오래 막지 않도록 모든 훅을 동시에 띄우고 전체 5초까지만 기다린다. ctx 훅은 표시 파일을 먼저 쓰도록 짜여 있어, 재색인이 잘려도 다음 `ctx load`가 따라잡는다.

### 3.6 naby가 직접 구현하는 세 가지

**활성화 (`activate.js` 대체).** skill-hub 프리셋에 저장된 API 키로 `GET /api/v1/harness/bootstrap`을 부른다.

- 성공하면 응답의 `env.HARNESS_METRICS_TOKEN`을 받아 naby 설정에 저장하고, 집계 훅에 `HARNESS_METRICS_TOKEN`으로 넘긴다. Claude Code의 `~/.cache/altimedia-harness/activation.json`은 읽지도 쓰지도 않는다.
- 확인은 하루(KST)에 한 번이다. 키를 바꾸면 바로 다시 확인한다. Skill Hub는 이 확인으로 그날 사용자를 센다.
- 401이면 조직 하네스를 끄고 설정 화면과 세션 시작에 "Skill Hub 키를 다시 넣어 주세요"를 띄운다. 네트워크 실패는 실패로 보지 않는다.
- skill-hub 프리셋이 없으면 조직 하네스를 받지 않는다. 온보딩의 skill-hub 단계가 곧 설치 단계가 된다.

**인증 차단 (`gate.js` 대체).** 조직 하네스가 켜져 있고 Atlassian OAuth가 준비되지 않았으면 프롬프트를 막고 설정 화면으로 안내한다.

- "준비됨"은 `atlassian` 프리셋(§3.8)에 OAuth 토큰이 있고, 마지막 갱신이 "다시 로그인 필요"로 끝나지 않은 상태다. 플러그인의 `gate.js`가 토큰이 있는지만 보는 것과 같은 기준이다. 이전 방식(API 토큰)이 남아 있는 상태는 "준비됨"이 아니다(§4.4).
- 한 번 확인되면 하루 동안 다시 보지 않는다. 설정 화면과 `/` 명령은 막지 않는다. 막힌 동안에도 인증할 수 있어야 한다.
- 끄는 방법은 `HARNESS_GATE=0` 환경 변수 하나다. 플러그인과 같다.

**의존성 점검 (`deps-check.js` 대체).** 세션 시작 때 Python 3과 PyYAML이 있는지 본다. 없으면 설정 화면의 조직 하네스 카드에 설치 방법을 띄운다. 프롬프트는 막지 않는다.

### 3.7 집계

H1~H4는 패키지의 `metrics-emit.js`를 §3.5 실행기로 그대로 돌린다. 단계 판정(입력·맥락·실행·검수·기록)과 페이로드 7개 필드는 Skill Hub 소유로 남고, 바뀌면 자동 갱신으로 따라온다.

- 보내는 필드는 `session_id`, `team`, `repo`, `event`, `stage`, `harness_version`, `ts`뿐이다. 프롬프트 본문, 파일 경로, 명령은 보내지 않는다.
- `repo`는 열린 프로젝트의 `git remote get-url origin`에서 나온다.
- 서브에이전트 안의 이벤트(`agent_id`)는 세지 않는다. 스크립트가 걸러 낸다.
- **naby 사용분을 따로 센다.** naby는 훅을 띄울 때 `HARNESS_CLIENT=naby`를 넣고, 활성화 확인(§3.6)에도 같은 값을 실어 보낸다. `metrics-emit.js`가 이 값을 `client` 필드로 보내고 서버가 나눠 세는 일은 Skill Hub 쪽 변경이다(부록 A). 그 변경이 오기 전에는 값이 무시되어 지금처럼 합쳐 잡힌다. naby 쪽은 먼저 넣어 두고 기다린다.
- **알려진 문제(Skill Hub 쪽).** `metrics-emit.js`는 "기록" 단계를 `^mcp__.*__confluence_(create|update)_page`로 판정한다. 이것은 `mcp-atlassian`의 도구 이름이다. 공식 OAuth MCP의 쓰기 도구는 `createConfluencePage`·`updateConfluencePage`라서 걸리지 않는다. Claude Code 플러그인에서도 같다. naby는 판정 규칙을 Skill Hub에 맡기므로(위) 여기서 고치지 않고, 플러그인 쪽 수정(부록 A)을 따라간다. naby는 MCP 도구를 `mcp__atlassian__createConfluencePage` 철자로 넘긴다(§3.5).

### 3.8 Atlassian은 OAuth 하나로 간다

시스템 MCP 프리셋 `atlassian`을 **공식 원격 MCP + 브라우저 OAuth**로 바꾼다. API 토큰을 받아 `mcp-atlassian`(uvx stdio)을 띄우던 방식은 없앤다. 조직 하네스를 쓰지 않는 사용자에게도 같다. Atlassian 연결 방식은 이것 하나다.

| 항목 | 값 |
|---|---|
| 서버 이름 | `atlassian` 그대로. 플러그인의 서버 이름과도 같다 |
| 전송 | `http`, `https://mcp.atlassian.com/v1/mcp` |
| 입력 필드 | 없다. "연결" 버튼 하나다. Confluence 주소·계정·API 토큰 입력란과 uvx 확인을 없앤다 |
| 도구 이름 | `atlassian__getConfluencePage` 꼴로 바뀐다(이전 `atlassian__confluence_get_page`). ctx·pdoc 본문은 뒷부분(`getConfluencePage`)으로 찾으라고 안내한다. Jira 도구도 함께 온다 |

**OAuth 흐름.** `@ai-sdk/mcp` 2.0.15의 `authProvider`(`OAuthClientProvider`)를 구현해 `mcp.ts`의 http 연결에 넘긴다. 구현은 런타임(`src/runtime/mcp-oauth.ts`)에 둔다. 브라우저를 여는 일만 셸이 한다.

1. Atlassian 인증 서버 정보를 받아 동적 클라이언트 등록을 한다. 등록 결과는 저장해 다시 쓴다.
2. PKCE로 인증 주소를 만들고, `127.0.0.1`의 임시 포트로 돌아오는 주소를 둔다. 시스템 브라우저로 연다.
3. 돌아온 코드를 토큰으로 바꾸고, 액세스 토큰과 갱신 토큰을 기존 MCP 비밀값과 같은 곳에 저장한다.
4. 턴마다 MCP에 연결할 때 `authProvider`가 토큰을 준다. 만료됐으면 갱신한다.

**갱신에서 지킬 것.** ChatGPT OAuth(`src/providers/chatgpt-oauth.ts`)에서 겪은 문제를 그대로 막는다.

- 갱신 토큰이 바뀌면(rotation) 새 값을 **먼저 저장하고** 쓴다. 저장 전에 죽으면 다음 갱신이 `refresh_token_reused`로 실패한다.
- 탭 여러 개가 동시에 갱신하지 않도록 한 번에 하나만 갱신한다(single-flight). 나머지는 그 결과를 기다린다.
- 갱신이 "다시 로그인 필요" 계열 오류로 끝나면 토큰을 지우고 상태를 "다시 로그인 필요"로 바꾼다. 인증 차단(§3.6)이 이 상태를 본다. 네트워크 오류는 다시 로그인으로 보지 않는다.

**내장 `confluence-upload` 스킬을 거둔다.** 이 스킬은 API 토큰을 셸 환경 변수로 받는 CLI를 부르고, `atlassian` 프리셋(API 토큰)을 켜짐 신호로 썼다(skill-hub-builtin §2.7.1). OAuth로 통일하면 둘 다 성립하지 않는다. Confluence 발행은 조직 스킬 pdoc이 OAuth MCP로 맡는다. 거두는 방법은 §4.4에 있다.

**확인할 것.** Atlassian 조직 관리자가 원격 MCP 사용을 막아 두었으면 연결이 실패한다. 사내에서는 Claude Code 플러그인이 같은 서버로 인증하고 있으므로 열려 있다고 보지만, naby의 동적 등록 클라이언트가 같은 대우를 받는지는 M3 첫 작업으로 실제 계정에서 확인한다. 막혀 있으면 §4.4의 전환을 멈추고 이 절을 다시 연다.

## 4. 기존 사용자 이전 — 업그레이드하면 끊김 없이 넘어온다

기존 사용자는 electron-updater로 새 버전을 받는다. 앱을 다시 시작하면 바로 이전이 시작된다. 목표는 셋이다. **업그레이드 직후에도 하던 일을 그대로 이어서 하고, 사용자가 손으로 해 둔 설정은 하나도 잃지 않고, 문제가 생기면 이전 상태로 되돌릴 수 있어야 한다.**

### 4.1 데이터베이스는 바꾸지 않는다

`SCHEMA_VERSION`은 13 그대로다. 조직 항목의 추가 정보는 `harness_items.payload` JSON 안의 새 필드(`loadMode`, `packageRef`)와 `settings`의 새 키(`harness.org.*`)에만 넣는다. 테이블과 열을 추가하지 않는다.

이렇게 하면 업그레이드 때 마이그레이션 단계가 없고, 이전 버전 앱으로 돌아가도 같은 DB를 그대로 연다. 나중에 열이 꼭 필요해지면 기존 방식(열이 없을 때만 `ALTER TABLE ... ADD COLUMN`, `sqlite-store.ts`)을 따른다.

### 4.2 시작을 기다리게 하지 않는다

부팅 순서는 지금과 같다. 조직 하네스 동기화는 창이 뜬 뒤 백그라운드에서 돈다.

1. 앱이 뜨고 이전 세션이 그대로 열린다. 이 시점에 조직 하네스는 아직 없다.
2. 백그라운드에서 패키지를 받고 확인하고 푼다(§3.1).
3. 다 끝나면 행을 반영한다(§3.2). 반영은 턴과 턴 사이에만 한다. 진행 중인 턴에는 끼어들지 않는다.
4. 다음 턴부터 스킬 목록과 훅이 적용된다.

네트워크가 없거나 느려도 1번은 지금과 똑같이 동작한다.

### 4.3 누구에게 켜지는가

토큰 저장을 옵트인으로 보는 기존 원칙(skill-hub-builtin §2.7)을 그대로 쓴다.

| 기존 사용자 상태 | 업그레이드 후 |
|---|---|
| skill-hub 프리셋을 설정했다 | 활성화(§3.6)가 성공하면 조직 하네스가 켜진다 |
| skill-hub 프리셋이 없다 | 아무것도 바뀌지 않는다. 설정 화면의 조직 하네스 카드에 "Skill Hub 키를 넣으면 사내 하네스가 켜진다"만 보인다 |
| 키가 거부된다(401) | 조직 하네스를 켜지 않고 키를 다시 넣으라고 안내한다. 다른 기능은 그대로 쓴다 |
| 기존 `atlassian`(API 토큰) 프리셋을 쓴다 | OAuth로 옮길 때까지 그대로 동작한다(§4.4) |

### 4.4 API 토큰에서 OAuth로 옮긴다

기존 `atlassian` 프리셋(API 토큰, `mcp-atlassian`)을 쓰던 사용자가 대상이다. 업그레이드하자마자 끊기지 않도록, **사용자가 브라우저 로그인을 마칠 때까지 이전 방식을 그대로 돌린다.**

1. 업그레이드 뒤 첫 부팅에서 `mcp_servers`의 `atlassian` 행이 stdio(`mcp-atlassian`)면 "OAuth 전환 대기"로 표시한다. 행은 그대로 두고 지금처럼 쓴다.
2. 설정 화면의 Atlassian 카드와 세션 시작 알림으로 "브라우저로 한 번 로그인해 주세요"를 띄운다. 조직 하네스의 인증 유예(§4.6) 7일과 같은 기간을 쓴다.
3. 사용자가 로그인을 마치면 **같은 이름의 행을 그 자리에서 바꾼다.** 전송을 http로, 주소를 공식 MCP로 바꾸고, 저장해 둔 Confluence 주소·계정·API 토큰을 지운다. 바꾸는 일은 턴 사이에만 한다.
4. 바꾼 뒤에는 도구 이름이 달라진다(`atlassian__confluence_get_page` → `atlassian__getConfluencePage`). 사용자 하네스나 권한 규칙 중 옛 도구 이름을 가리키는 것이 있으면 개수와 목록을 설정 화면에 보여 준다. 자동으로 고치지는 않는다.
5. 로그인에 실패하거나 사용자가 미루면 1번 상태가 계속된다. 유예가 끝나면 조직 하네스의 인증 차단만 걸리고, 이전 방식의 MCP는 계속 돈다.

**내장 `confluence-upload` 거두기.** 3번 전환이 끝나는 순간 함께 처리한다.

- `autoStatus` 기록과 현재 상태가 같으면(사용자가 손대지 않았으면) 행을 `removed`로 바꾸고 출처에 `builtin-withdrawn`을 남긴다. 사용자가 지운 묘비와 구분한다.
- 사용자가 손댄 행(켜고 끈 적이 있거나 본문을 고친 행)은 사용자 소유라 그대로 둔다. 설정 화면에 "이 스킬은 더 이상 기본 제공되지 않는다, Confluence 발행은 pdoc을 쓴다"를 띄운다.
- 앱에 함께 묶던 원문(`src/runtime/harness-assets/skills/confluence-upload/`)과 `atlassian` 번들 항목은 이 버전에서 지운다. 새로 설치한 사용자에게는 처음부터 들어가지 않는다.

**이전 버전 앱으로 돌아가면.** 전환 전이면 아무 차이가 없다. 전환 뒤면 이전 버전은 http `atlassian` 행을 OAuth 없이 연결하려다 401을 받는다. 기존 오류 처리대로 그 턴에 "연결 실패" 경고만 남고 턴은 계속된다. 이전 버전에서 Atlassian을 다시 쓰려면 프리셋을 다시 설정해야 한다. 되돌릴 일이 생기면 이 점을 안내한다.

### 4.5 이미 설치한 같은 이름의 스킬

task·pdoc·ctx는 Skill Hub에 개별 스킬로도 올라와 있다. 기존 사용자가 그것을 `~/.naby/skills/`에 설치했을 수 있다. 그 사본은 user 범위라 순위상 조직 버전을 가리고, 자동 갱신을 받지 못한다.

**naby는 사본을 스스로 끄지 않는다.** 사용자가 고른다. 고르기 전까지는 지금처럼 사본이 쓰이고, 그 스킬만 조직 버전의 자동 갱신을 받지 못한다. 업그레이드 직후 동작이 바뀌지 않는 쪽을 택한 것이다.

| 기존 사본 | 처리 |
|---|---|
| 켜져 있다 | 그대로 둔다. 알림을 띄운다(아래) |
| 꺼져 있다 | 그대로 둔다. 가리지 않으므로 알림도 없다 |
| 사용자가 이미 지웠다(묘비) | 건드리지 않는다. 조직 버전은 범위가 달라 따로 들어온다 |

알림은 세션 시작 때 한 번, 설정 화면의 조직 하네스 카드에는 고를 때까지 계속 뜬다. 선택지는 둘이다.

- **조직 버전 쓰기.** 사본을 끄고 `supersededBy: org:altimedia-harness`를 남긴다. 파일은 지우지 않는다. 설정에서 사본을 다시 켜면 원래대로 돌아간다.
- **내 사본 유지.** 아무것도 바꾸지 않고 `harness.org.<name>.keepUserCopy`를 남긴다. 이후 알림을 띄우지 않는다. 설정 카드에서 언제든 다시 고를 수 있다.

알림 문구에는 사본이 고친 것인지 함께 보여 준다. 본문이 Skill Hub에 올라온 어느 버전과 같으면 "고치지 않은 사본", 다르면 "직접 고친 사본"이다. 판단은 사용자가 하고, naby는 근거만 준다.

같은 이름의 Claude Code 플러그인이 `~/.claude`에 설치돼 있는 것은 상관없다. naby는 그 폴더를 읽지 않는다(harness-standalone).

### 4.6 인증 차단은 바로 걸지 않는다

업그레이드한 다음 날 갑자기 프롬프트가 막히면 그것이 곧 중단이다. 그래서 기존 사용자에게는 단계를 둔다.

- 업그레이드 후 **7일**은 막지 않는다. 그 동안은 세션 시작마다 "Atlassian 설정이 필요하다, N일 뒤부터 막힌다"를 띄운다.
- 7일이 지나도 **이미 진행 중인 세션은 막지 않는다.** 새로 시작하는 세션부터 막는다.
- 새로 설치한 사용자는 패키지를 받은 뒤 바로 막는다.
- 유예 시작일은 `harness.org.gateGraceStartedAt`에 남긴다. 유예 기간 7일은 설정값이다.

### 4.7 진행 중인 세션과 패키지 교체

- 다시 시작한 뒤 이어지는 세션에는 `SessionStart`를 `source: "resume"`으로 한 번 보낸다. 집계는 새 세션으로 세지 않는다.
- 패키지 교체는 턴 사이에만 일어난다. 턴은 시작할 때의 패키지 경로를 고정해 쓴다. 직전 버전 폴더를 하나 남기므로(§3.1), 교체 직후에도 이미 시작한 턴과 훅은 옛 경로에서 끝까지 돈다.
- 이전 버전 앱으로 돌아가면 조직 행은 `naby_skill_load` 도구가 없어 주입되지 않는다(§3.2). 훅과 집계도 돌지 않는다. 사용자가 만든 행과 설정은 그대로 남는다.

### 4.8 되돌리기

조직 하네스를 끄는 스위치를 둔다. 설정 화면의 토글과 환경 변수 `NABY_ORG_HARNESS=0` 두 가지다. 끄면 이렇게 된다.

- 조직 행을 모두 끈다. 지우지 않는다.
- §4.5에서 사용자가 "조직 버전 쓰기"를 골라 꺼진 사본을 다시 켠다(`supersededBy` 표시가 있는 것만).
- 훅과 집계를 멈추고, 인증 차단도 푼다.

다시 켜면 같은 상태로 돌아온다. 업그레이드 전과 같은 상태로 돌아가는 데 앱을 다시 설치할 필요가 없다.

### 4.9 이전 검증

스파이크 `spike:org-harness-migrate`가 임시 `NABY_HOME`에서 아래 경우를 돌린다. 실제 `~/.naby`는 쓰지 않는다.

1. 새로 설치한 DB
2. v13 DB, skill-hub 미설정: 업그레이드 뒤 행과 설정이 바이트 단위로 같다
3. v13 DB, skill-hub 설정, 같은 이름 사본이 없다
4. 고치지 않은 task 사본이 있다: 켜진 채로 남고 "고치지 않은 사본" 알림이 뜬다. "조직 버전 쓰기"를 고르면 꺼지고 표시가 남으며, §4.8 스위치로 되돌아온다
5. 고친 pdoc 사본이 있다: 켜진 채로 남고 "직접 고친 사본" 알림이 뜬다. "내 사본 유지"를 고르면 알림이 다시 뜨지 않는다
6. 첫 부팅이 사내망 밖이다: 부팅과 첫 턴이 지금과 같고, 연결되면 반영된다
7. 턴 도중에 새 버전이 도착한다: 그 턴은 옛 경로로 끝나고 다음 턴이 새 경로를 쓴다
8. 조직 행이 든 DB를 이 기능 이전의 `skill-inject`로 읽는다: 주입되지 않고 `excludedForTools`로 센다
9. 인증 유예: 7일 안에는 막지 않고, 지난 뒤에는 새 세션만 막는다
10. API 토큰 `atlassian` 행이 있는 DB: 로그인 전에는 stdio 행이 그대로 쓰이고, 로그인 뒤에는 같은 이름의 http 행으로 바뀌며 API 토큰이 남지 않는다. 옛 도구 이름을 가리키는 규칙 수가 보고된다
11. 손대지 않은 `confluence-upload`는 전환과 함께 `builtin-withdrawn`이 되고, 사용자가 끈 적이 있는 행은 그대로 남는다

릴리스 전에는 이 맥의 실제 `~/.naby`를 **복사한** 임시 `NABY_HOME`으로, GitHub에서 받은 패키징본을 한 번 띄워 확인한다. 원본은 건드리지 않는다.

## 5. 단계와 검증

| 단계 | 내용 | 끝났다는 증거 |
|---|---|---|
| M1 | 패키지 받기·검증·풀기(§3.1), 행 반영(§3.2), 활성화(§3.6), 기존 사용자 이전(§4.1~4.3, 4.5, 4.8) | 스파이크: sha256 불일치 거부, 중단 시 이전 버전 유지, 재실행 무변화, 사용자가 끈 행 유지, 빠진 스킬 `org-withdrawn`, `spike:org-harness-migrate` 1~6·8 |
| M2 | 필요할 때 불러오기(§3.3), 호환 계층(§3.4) | 스파이크: 목록만 예산에 들어감, `naby_skill_load` 결과에 경로 치환과 안내문, `~/.naby/org` 쓰기 거부. 실제 모델로 `/task start` 한 번 |
| M3 | 훅 실행기(§3.5), Atlassian OAuth 프리셋(§3.8), 인증 차단·의존성 점검(§3.6), API 토큰에서 OAuth로 전환(§4.4), 인증 유예(§4.6), 세션 이어받기(§4.7) | 스파이크: 시점 7개 발생, 도구 이름 변환 표 전체, OAuth 갱신 single-flight·rotation 선저장·재로그인 판정(가짜 인증 서버), 실제 계정으로 `atlassian-cloud` 연결 1회, `ask`가 승인 UI로 감, 허용 목록 밖 훅 미실행, 실패한 훅이 턴을 막지 않음, `SessionEnd` 5초 상한 |
| M4 | 집계(§3.7), 6시간 주기 갱신, 턴 도중 교체(§4.7) | `HARNESS_METRICS_DRYRUN=1`로 단계별 페이로드 확인, 두 엔진에서 같은 이벤트 수 |

엔진 턴 루프를 건드리므로 각 단계에서 `npm run spike:autonomy`와 `npm run spike:02`를 먼저 돌린다. 스파이크와 셸 테스트는 `NABY_DB_PATH`·`NABY_HOME`을 임시 경로로 둔다. 실제 `~/.naby`에 조직 패키지를 풀지 않는다.

릴리스 확인은 packaging-path-resolution §4대로 GitHub에서 받은 아티팩트로 한다. 특히 `ELECTRON_RUN_AS_NODE`로 훅을 띄우는 경로는 패키징본에서만 의미가 있다.

## 6. 미결정

- **Skill Hub 쪽 변경 일정.** 부록 A의 요청이 반영되기 전까지 naby 사용분은 Claude Code 사용분과 합쳐 잡히고, "기록" 단계는 잡히지 않는다.
- **다른 조직 패키지.** 마켓플레이스의 다른 플러그인도 같은 경로로 받을지. 이 문서는 altimedia-harness 하나로 한정한다.
- **패키지 서명.** Skill Hub가 서명 키를 공개하면 sha256 대신 서명 검증으로 올린다.
- **허용 목록 갱신 주기.** 패키지에 새 훅이 생기면 naby 릴리스 전까지 돌지 않는다. 그 사이 차이를 어떻게 알릴지.

## 부록 A. Skill Hub에 요청하는 변경

naby 쪽은 아래 변경을 기다리지 않고 먼저 동작한다. 반영되면 자동 갱신으로 따라온다.

| # | 대상 | 요청 | 이유 |
|---|---|---|---|
| A1 | `scripts/metrics-emit.js` | 환경 변수 `HARNESS_CLIENT`를 읽어 페이로드에 `client` 필드로 보낸다. 값이 없으면 `"claude-code"`. 허용 값은 `claude-code`, `naby` | naby 사용분을 따로 센다. naby는 훅을 띄울 때 `HARNESS_CLIENT=naby`를 넣는다 |
| A2 | `POST /api/v1/harness/events` | `client` 필드를 받아 저장한다. 없으면 `claude-code`로 본다. 적용률 화면에서 client별로 나눠 볼 수 있게 한다 | A1을 받는 쪽 |
| A3 | `GET /api/v1/harness/bootstrap` | 요청 헤더 `X-Harness-Client: naby`(없으면 `claude-code`)를 받아, 설치자·주간 활성 사용자도 client별로 센다 | naby는 하루 한 번 이 API로 키를 확인한다(§3.6) |
| A4 | `scripts/metrics-emit.js`, `hooks/hooks.json` | "기록" 단계 판정에 공식 Atlassian MCP의 쓰기 도구를 더한다. 예: `^mcp__.*__(confluence_(create\|update)_page\|(create\|update)ConfluencePage)$`. `hooks.json`의 `PostToolUse` matcher도 같이 넓힌다 | 하네스의 atlassian MCP는 공식 OAuth MCP라 쓰기 도구가 `createConfluencePage`·`updateConfluencePage`다. 지금 규칙은 `mcp-atlassian`의 이름만 잡아서, Claude Code 플러그인에서도 "기록" 단계가 잡히지 않는다 |
| A5 | `hooks/hooks.json`에 새 스크립트를 넣을 때 | 변경 기록(CHANGELOG)에 "새 훅 스크립트"를 따로 적는다 | naby는 허용 목록에 있는 스크립트만 돌린다(§3.5). 새 훅은 naby 릴리스에서 검토한 뒤 허용한다 |

참고로 naby가 넘기는 도구 이름은 `mcp__atlassian__createConfluencePage` 꼴이고, Claude Code 플러그인에서는 `mcp__plugin_altimedia-harness_atlassian__createConfluencePage` 꼴이다. A4의 정규식은 둘 다 잡아야 한다.

## 7. 구현 상태

2026-10-07 기준이다.

### 7.1 M1 (naby 40547d9, 셸 e013b9c)

패키지 받기·sha256 확인·풀기·`current` 전환(§3.1), 조직 행 반영과 `org-withdrawn`(§3.2), 활성화(§3.6의 활성화 부분), 기존 사용자 이전(§4.1~4.3, §4.5, §4.8)을 넣었다. `spike:org-harness-migrate`와 셸의 `orgHarness.test.ts`가 확인한다.

### 7.2 M2

아래를 넣었다. `spike:org-harness-load`와 셸 테스트(`nabyOrgHarnessTurn.test.ts` 외)가 확인한다.

- **필요할 때 불러오기(§3.3).** `loadMode: "on-demand"` 행은 본문 선택에 들어가지 않는다. 이름과 description 목록으로만 들어가고, 목록 예산(1500토큰)과 집계는 본문 예산과 따로 센다. 목록 머리말이 "쓰기 전에 `naby_skill_load`를 부르라"고 말한다. 같은 이름의 project·user 스킬이 켜져 있으면 그 이름은 목록에서 뺀다(§3.2의 범위 순위).
- **`naby_skill_load`.** 두 엔진이 같은 런타임 도구를 쓴다. Claude 엔진에서는 `nabytools` 서버로 보인다. 결과는 §3.4 안내문, 스킬 폴더 절대 경로, 자리표시자를 바꾼 본문이다. 셸이 있는 턴에만 준다. 셸이 있는 턴은 프로젝트가 열려 있고 변경이 허용된 턴이다. Claude 엔진에서는 SDK의 `Bash`를 `run_command`로 본다.
- **이름으로 부르면 미리 불러 둔다.** 줄 머리에 쓴 `/task start …`도 같다. `/` 팔레트에서 조직 스킬을 고르면 지금처럼 `/task `가 입력된다. 보낼 때 디스패처는 description을 펼치지 않고 그 줄을 그대로 둔다. 엔진이 그 이름을 런타임에 넘기고, 런타임이 본문을 그 턴의 시스템 프롬프트에 넣는다.
- **끄는 스위치를 주입에서도 지킨다(§4.8).** 턴 시작 때 스위치가 꺼져 있으면 행 상태와 관계없이 목록과 미리 불러오기를 하지 않는다. `naby_skill_load`와 명령 환경 변수는 부를 때마다 스위치를 다시 본다.
- **턴마다 패키지 경로를 고정한다(§4.7).** 턴 시작 때 한 번 정한 폴더를 목록·불러오기·환경 변수가 끝까지 쓴다. 자율 실행의 모든 단계도 같다. 턴 도중 새 버전이 와도 그 턴은 옛 폴더에서 끝난다(§4.9의 7번).
- **게이트.** `<NABY_HOME>/org/` 아래 쓰기는 `realPolicy`가 사용자 규칙보다 먼저 거부한다. naby의 `write_file`·`edit_file`과 SDK의 `Write`·`Edit`·`MultiEdit`·`NotebookEdit`가 대상이다. 읽기는 `read_file`·`list_dir`의 프로젝트 경계에 읽기 전용 루트를 더해 허용한다. 경계 판정은 `fs-tools.ts`의 `isPathInside` 하나를 같이 쓴다.
- **호환 계층(§3.4).** 불러올 때 안내문을 붙이고 `${CLAUDE_PLUGIN_ROOT}`·`${CLAUDE_SKILL_DIR}`를 절대 경로로 바꾼다. `run_command`의 명령 줄이 패키지 폴더나 두 자리표시자를 가리키면 §3.4의 환경 변수를 넣는다. Skill Hub 키 이름의 변수(`CLAUDE_PLUGIN_OPTION_SHUB_API_KEY`, `SHUB_API_KEY`)는 그 명령의 환경에서 지운다. 다른 명령의 환경은 건드리지 않는다.
- **설정 화면과 알림(§4.5, §4.8).** 설정 → 하네스 맨 위에 조직 하네스 카드를 두었다. 버전, 마지막 확인, 키 상태(확인됨·거부됨·키 없음), 켜고 끄기, 조직 스킬과 켜짐 여부, 같은 이름 사본의 두 선택지("조직 버전 쓰기"·"내 사본 유지")와 사본 종류("고치지 않은 사본"·"직접 고친 사본")를 보여 준다. 새 세션의 첫 턴에는 같은 이름 사본과 키 거부를 하네스 알림으로 한 번 띄운다.

### 7.3 구현하며 확인한 사실

- 0.8.1 본문은 스크립트를 `${CLAUDE_SKILL_DIR}` 기준으로 부른다. 그래서 §2와 §3.4 표에 이 자리표시자를 더했다.
- 0.8.1에서 `CLAUDE_PLUGIN_OPTION_CIC_TOKEN`을 읽는 스크립트는 `activate.js`뿐이다. pdoc의 `template_source.py`는 `CIC_API_TOKEN`을 읽는다. 지금 넣는 cic 변수는 스킬 스크립트에 닿지 않는다.
- 셸의 하네스 홈 스캔은 `NABY_HOME`이 아니라 `os.homedir()` 아래 `~/.naby/skills`를 읽는다. 임시 홈으로 띄운 셸도 실제 홈의 스킬을 읽는다. 쓰지는 않는다. 이 문서 범위 밖이지만 §4.9의 릴리스 전 확인 때 주의한다.

### 7.4 남은 일

- **M3.** 훅 실행기(§3.5), Atlassian OAuth 프리셋(§3.8)과 API 토큰에서의 전환(§4.4), 인증 차단과 의존성 점검(§3.6), 인증 유예(§4.6), 이어받은 세션의 `SessionStart`(§4.7)를 넣는다. 함께 정할 것이 셋 있다.
  - Claude 엔진의 SDK `Bash`에는 §3.4 환경 변수가 아직 들어가지 않는다. 명령마다 환경을 줄 자리가 없다. SDK가 띄우는 프로세스의 환경은 훅 실행기와 함께 다룬다.
  - 셸 명령(`run_command`·`Bash`)으로 `<NABY_HOME>/org/`에 쓰는 일은 막지 않는다. 경로 인자가 없는 도구라 게이트가 볼 수 없다.
  - cic 토큰을 `CIC_API_TOKEN`으로도 넣을지 정한다(7.3).
- **M4.** 집계(§3.7)와 6시간 주기 확인을 넣는다.
- **M2 증거 중 남은 것.** §5의 "실제 모델로 `/task start` 한 번"은 아직 하지 않았다. 같은 경로(목록, 미리 불러오기, 도구 목록)는 가짜 모델로 셸 테스트가 확인한다.
