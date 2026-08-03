---
id: skill-hub-builtin
title: System MCP — 내장 프리셋(skill-hub · Atlassian)
type: design
version: 0.5.0
status: active
scope: 사내 표준 MCP(skill-hub, mcp-atlassian)를 naby 레이어의 내장 System MCP 프리셋으로 만든다. 프리셋 레지스트리(선언적 필드 정의 + 서버 측 엔트리 조립), 첫 실행 온보딩 스텝, 설정의 System MCP 카드, 비밀값이 클라이언트로 왕복하지 않는 쓰기 경로를 다룬다. MCP 로더·게이트·스킬 주입은 기존 계약을 그대로 쓴다.
related: [phase-3-persona-agent, phase-1_6-harness-ownership, harness-standalone]
updated: 2026-08-03
---

# System MCP — 내장 프리셋(skill-hub · Atlassian)

> 상태: 설계 확정(2026-08-03, 0.5.0에서 §2.5 신뢰 규칙을 개정 — naby 홈 도착분은 켜진 채로 온다). 한 줄 요약: 사내 표준 MCP는 사용자가 URL·transport·헤더를 알 필요가 없는 **내장 프리셋**이다. 필요한 자격값 한두 개만 넣으면 연결/테스트까지 바로 된다.

## 1. 배경과 원칙

- skill-hub는 HTTP MCP다: `https://skills.altimedia.com/mcp` + `Authorization: Bearer shub_...`. 런타임 MCP 로더는 http+headers를 이미 끝까지 지원하므로(`src/runtime/mcp.ts`), 이 작업은 **새 전송 경로가 아니라 프리셋 UX**다.
- 원칙: **사용자가 아는 것은 토큰뿐이다.** URL·transport·헤더 이름은 제품이 안다. 일반 MCP 추가 폼과 달리 skill-hub 입력은 토큰 필드 하나다.
- 토큰 저장은 기존 MCP 관례를 따른다 — `mcp_servers.payload`의 headers에 저장하고, 읽기는 키 이름만 노출(redact). 텔레그램 봇 토큰과 같은 등급이며 vault 승격은 이 스펙의 범위 밖이다.

## 2. 설계

### 2.1 프리셋 레지스트리 (셸 lib)

`lib/systemMcp.ts`가 선언적 레지스트리를 소유한다. 프리셋 하나는 다음을 선언한다: 서버 이름, 표시명·설명 i18n 키, **필드 정의**(id·라벨 키·secret 여부·placeholder), 그리고 `build(fields, urlOverride?)` 순수 조립 함수. UI와 API는 레지스트리를 순회할 뿐 프리셋별 분기를 갖지 않는다 — 세 번째 프리셋은 선언 하나로 늘어난다.

- **skill-hub**: 필드 `token`(secret). `{transport:'http', url:'https://skills.altimedia.com/mcp', headers:{Authorization:'Bearer <token>'}}`. 토큰은 trim + `Bearer ` 중복 정규화. URL은 설정 `skillHub.url`로 덮어쓸 수 있다(UI 미노출).
- **atlassian**: 필드 `username`(회사 이메일), `apiToken`(secret). `{transport:'stdio', command:<uvx 절대경로>, args:['mcp-atlassian'], env:{CONFLUENCE_URL:'https://altimedia.atlassian.net/wiki', CONFLUENCE_USERNAME, CONFLUENCE_API_TOKEN}}`. URL은 설정 `atlassian.confluenceUrl`로 덮어쓸 수 있다. Jira env는 후속(§4).
  - **stdio의 함정은 PATH다.** 패키징된 Electron의 자식 프로세스는 로그인 셸 PATH를 물려받지 않으므로, 저장 시점에 서버가 `uvx` 절대경로를 해석해(`command -v` 로그인 셸 폴백 + 잘 알려진 경로 후보) 엔트리에 굳힌다. 해석 실패면 저장을 거부하고 uv 설치 안내를 답한다 — 연결 테스트에서야 죽는 것보다 낫다.
- 연결 판정 `readSystemMcpStatus(store)`: 프리셋별 `{configured, status}` 맵. 같은 질문에 답하는 함수를 UI가 따로 만들지 않는다.

### 2.2 API — 비밀값은 서버로만 간다

- `systemMcp.set {preset, fields}`: 서버가 레지스트리로 조립·검증해 `upsertMcpEntry`. 필수 필드 누락 거부. 응답은 redact된 상태만.
- `systemMcp.test {preset}`: 기존 `probeMcpServer` 재사용(도구 수·이름 반환, 실제 툴 호출 없음).
- `systemMcp.remove {preset}`.
- GET 상태에 `systemMcp: {<preset>: {configured, status}}`. 어떤 응답에도 secret 필드 값이 실리지 않는다(기존 redactEntry 규칙 + env 값 redact).
- 0.1.0의 `skillHub.*` 액션은 이 일반형으로 흡수한다(커밋 전 리팩터링이라 하위호환 부담 없음).

### 2.3 온보딩 스텝

- 프로바이더 스텝 **다음**에 System MCP 스텝 하나: 프리셋별 입력 블록(skill-hub 토큰 / Atlassian 이메일+토큰)을 세로로 나열하고, 각각 연결(저장→테스트, 도구 수 표시)과 독립적 성공 표시. "나중에 하기"로 건너뛰어도 온보딩은 완료된다.
- 위저드의 기존 완료 판정(`onboarding.complete`)은 건드리지 않는다 — System MCP는 온보딩 필수 조건이 아니다.

### 2.4 설정 System MCP 카드

- MCP 서버 섹션을 둘로 나눈다: **System MCP**(프리셋 행들 — 상태·필드 입력·연결/테스트/제거)와 **사용자 추가 MCP**(기존 목록·추가 폼). 프리셋 이름의 엔트리는 일반 목록에서 필터한다.
- secret 필드는 텔레그램 관례(빈 입력은 유지, 새 값만 교체, 저장값 미표시). username 같은 비밀 아닌 필드는 저장값을 보여준다.
- 에이전트가 `naby_add_mcp`로 같은 이름을 제안하면 프리셋 행이 proposed 상태와 승인 버튼을 보여준다(기존 `mcp.approve` 재사용).

### 2.5 naby 하네스 홈 — 설치는 벤더 디렉터리가 아니라 내 자산 디렉터리로 (0.4.0에서 개정)

skill-hub의 설치 안내는 Claude Code 관례(`~/.claude/skills`)를 따르므로, 모델이 스킬을 **벤더 디렉터리**에 설치한다. naby의 철학("기억과 하네스를 벤더 밖 내 자산으로")과 어긋나고, dev-claude 엔진에서는 SDK 네이티브 로드와 naby 주입이 같은 파일을 이중 전달하는 비대칭도 있다. 해법은 셋이다.

- **naby 하네스 홈 신설**: `~/.naby/{skills,commands,agents}`(user)과 `<cwd>/.naby/{skills,commands,agents}`(project). 이 위치의 파일은 어떤 엔진에서도 SDK가 직접 읽지 않으므로 **모든 엔진에서 전달 경로가 naby 스토어 하나**가 된다(D4 import-then-own의 대칭적 완성).
- **스캔은 naby 홈 하나뿐이다**(0.4.0 개정). 0.3.0의 "이중 스캔"은 폐기한다 — 목록 스캔은 `.claude`를 읽지 않는다. `.claude`는 **명시적 가져오기 버튼 안에서만** 읽고, 읽는 순간 아티팩트를 naby 홈으로 **복사**해 `provenance.origin`을 naby 경로로 기록한다(벤더 경로는 감사용 `importedFrom`에만 남는다). 이름이 겹치면 **naby 홈이 이긴다** — 벤더 사본은 건너뛰고 요약에 보고한다. 근거와 전체 계획은 [하네스 단독 소유](harness-standalone.md) §2.1·§2.2에 있다.
- **설치 유도 지침**: skill-hub MCP가 이 턴에 연결돼 있을 때만, 턴 시스템 조립(`turnSystem`)에 한 줄을 넣는다 — 스킬/커맨드/서브에이전트를 설치할 때는 `~/.claude`가 아니라 naby 하네스 홈에 설치하라, 설치 안내가 `~/.claude`를 가리키면 경로만 치환하라. 기존 지침 주입 관례(능력과 짝지어진 조건부 주입)를 그대로 따른다.

이 지침은 0.4.0에서 **더 중요해진다**. 이제 목록 스캔이 `.claude`를 보지 않으므로, 모델이 벤더 디렉터리에 설치한 스킬은 사용자가 가져오기를 누르기 전까지 나타나지 않는다. 지침이 목적지를 naby 홈으로 돌려놓는 것이 첫 번째 방어선이고, 가져오기 버튼은 이미 잘못 설치된 것을 회수하는 두 번째 수단이다.

**신뢰 규칙을 0.5.0에서 개정한다: naby 홈에 새로 도착한 항목은 켜진 채로 온다.**

0.4.0까지는 naby 홈의 파일도 disabled로 도착했고 사람이 켜야 살았다. 그런데 실제 흐름에서 그 규칙이 지키는 것이 없었다. 사용자가 대화에서 스킬을 요청하고, 그 턴은 게이트를 지나 눈앞에서 실행되며, 결과 파일이 `~/.naby/skills/<name>/SKILL.md`에 놓인다. 그런데 스킬은 아무 일도 하지 않는다 — 아무도 알려주지 않은 설정 화면의 스위치를 찾아 눌러야 비로소 `/`에 나타난다. 게이트가 막는 대상은 "디스크에 그냥 존재하는 남의 트리"였는데, naby 홈은 그런 곳이 아니다. **판단 기준은 바이트의 출처가 아니라 도착시킨 행위의 출처다.**

- **규칙**: `provenance.origin`이 naby 하네스 홈 아래인 **신규 행**은 `enabled`로 도착한다. 그 밖의 전부는 그대로다 — 벤더 `.claude` 가져오기, 세트 임포트, origin을 모르는 항목은 여전히 disabled로 도착한다(게이트 불변식 1·3).
- **판정 위치**: 게이트는 순수 함수로 남는다(홈 디렉터리도, 설정도 읽지 않는다). naby 베이스 판정은 **임포터**가 하고, 결과를 `HarnessImportRequest.autoEnable`로 실어 보낸다. 베이스 판정은 삭제 티어가 쓰는 `nabyHarnessBases`를 **그대로 재사용**한다 — "이 파일은 naby 것인가"라는 질문의 답이 둘이 되면 안 된다.
- **적용 범위는 신규 행뿐이다**(게이트 불변식 7). 이미 있는 행의 상태는 스캔이 절대 바꾸지 않는다(불변식 5). 사용자가 꺼 둔 naby 홈 스킬은 몇 번을 다시 스캔해도 꺼진 채다. 묘비('removed')는 여전히 임포트가 요청할 수 없다(불변식 6).
- **끌 수 있다**: 설정 `harness.autoEnableNabyHome`(기본 켜짐). 끄면 0.4.0 동작으로 돌아간다 — 보이되 꺼진 채 도착한다. 이 설정은 **앞으로 도착할 항목**에만 적용된다. 이미 켜진 스킬을 조용히 끄지 않는다(그 편이 이 변경이 없애려는 놀람보다 더 나쁜 놀람이다).
- **문구**: 하네스 패널의 자동 스캔 안내가 두 절반을 모두 말한다 — naby 홈 스킬은 나타나고 바로 켜진다, 다른 제품 폴더에서 가져온 항목은 켜기 전까지 꺼져 있다(en/ko). 스위치는 같은 자리에 체크박스 한 줄로 둔다.

### 2.6 바꾸지 않는 것

- MCP 로더·게이트·정책·스킬 주입·엔진 경로는 무변경. 연결되면 도구는 기존 경로로 자동 노출되고, `readOnlyHint` 없는 skill-hub 도구는 결과적(consequential)으로 집계된다(M8d fail-closed 그대로).
- 토큰 암호화(vault 승격)는 하지 않는다. `app.db` 암호화 미결(전략 §7.2)과 함께 다룰 일이다.

## 3. 검증 계획

- 자동 활성화(§2.5, 0.5.0) — 스파이크 `spike:harness`에 게이트 불변식 7 검사를 넣는다(신규 naby 홈 행은 enabled·enabled 전용 목록에 보임, 플래그 없으면 disabled, 벤더는 disabled, 사용자가 끈 행은 재스캔에도 꺼진 채, 묘비·신뢰 순서 불변). 셸에서는 임포터가 **어떤 아티팩트에 플래그를 다는지**(요청 수준)와 라우트 설치 플로우(파일 등장 → 목록 → 클릭 없이 enabled 목록에 보임, 킬 스위치 끄면 disabled)를 검증한다.
- 셸 vitest — 레지스트리 조립(정규화·Bearer 중복 방지·URL 덮어쓰기·Atlassian env 조립·uvx 해석 실패 거부), `systemMcp.set/test/remove` 액션(필수 필드 누락 거부, 응답에 secret 미포함 — set/test/remove/GET 전 경로 직렬화 검사), 상태 판정, 일반 목록의 프리셋 필터.
- 회귀 — 셸 전체, 타입체크 양 트리, `build:app`.
- 미검증 — 실제 서버와의 라이브 연결(자격값 필요), 온보딩 시각 렌더, 패키징본에서의 uvx 경로 해석.

## 4. 미결정

- 온보딩 스텝의 노출 조건. 1차는 항상 노출(건너뛰기 가능)로 시작한다. 사내 배포가 아닌 사용자에게 숨길지는 배포 대상이 넓어질 때 정한다.
- 토큰 만료/401의 사용자 알림. 지금은 턴 로그의 연결 실패 경고뿐이다 — 프리셋 행의 테스트 버튼이 1차 진단 수단이다.
- Atlassian Jira env(JIRA_URL 등) 추가와 stdio 서버의 턴별 프로세스 스폰 비용(현재 MCP는 턴마다 연결·해제 — stdio 프리셋이 늘면 캐싱을 검토한다).
- uvx 미설치 사용자를 위한 자동 설치 안내(또는 동봉). 1차는 저장 거부 + 안내 문구다.
