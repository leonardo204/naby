---
id: skill-hub-builtin
title: System MCP — 내장 프리셋(skill-hub · Atlassian · cic)
type: design
version: 0.7.0
status: active
scope: 사내 표준 MCP(skill-hub, mcp-atlassian, cic)를 naby 레이어의 내장 System MCP 프리셋으로 만든다. 프리셋은 내장 하네스 번들의 스위치도 겸한다 — cic는 confluence-context 스킬 + confluence-researcher 서브에이전트를, atlassian은 confluence-upload 스킬을 켠다. 프리셋 레지스트리(선언적 필드 정의 + 서버 측 엔트리 조립), 첫 실행 온보딩 스텝, 설정의 System MCP 카드, 비밀값이 클라이언트로 왕복하지 않는 쓰기 경로를 다룬다. MCP 로더·게이트·스킬 주입은 기존 계약을 그대로 쓴다.
related: [phase-3-persona-agent, phase-1_6-harness-ownership, harness-standalone]
updated: 2026-08-12
---

# System MCP — 내장 프리셋(skill-hub · Atlassian · cic)

> 상태: 설계 확정(2026-08-12, 0.6.0에서 §2.7을 가산 — cic 프리셋과 내장 하네스 번들. 자격값 저장이 곧 번들의 스위치이고, 사용자가 손으로 끈 것은 이기지 않는다. 0.6.1에서 내장 스킬을 트리거 게이팅으로 바꿈 — 1722토큰짜리 문서가 항상-켜짐이면 매 턴 예산의 86%를 먹는다. 0.7.0에서 두 번째 번들 `confluence-upload`를 atlassian 프리셋에 붙이고, 번들 단위로 규칙을 일반화했다). 한 줄 요약: 사내 표준 MCP는 사용자가 URL·transport·헤더를 알 필요가 없는 **내장 프리셋**이다. 필요한 자격값 한두 개만 넣으면 연결/테스트까지 바로 된다.

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
- **스캔 트리거는 두 읽기 경로다**(0.5.1). 설정의 하네스 목록과 **"/" 팔레트 읽기**(`api/commands.ts`) 양쪽이 같은 스로틀 스캔을 먼저 돈다. 팔레트가 스캔 없이 읽던 동안에는 채팅 중 설치한 스킬이 설정을 열기 전까지 "/"에 보이지 않았다. 설치 지침의 도착 상태 문장도 하드코딩이 아니라 킬 스위치 설정값을 읽어 고른다(`harnessHomeInstruction`의 `autoEnable` 인자).

### 2.6 바꾸지 않는 것

- MCP 로더·게이트·정책·스킬 주입·엔진 경로는 무변경. 연결되면 도구는 기존 경로로 자동 노출되고, `readOnlyHint` 없는 skill-hub 도구는 결과적(consequential)으로 집계된다(M8d fail-closed 그대로).
- 토큰 암호화(vault 승격)는 하지 않는다. `app.db` 암호화 미결(전략 §7.2)과 함께 다룰 일이다.

### 2.7 cic 프리셋과 내장 하네스 번들 (0.6.0에서 추가)

**cic**는 사내 Confluence 색인 MCP다. 전송 형태는 skill-hub와 같다 — HTTP + Bearer 토큰 하나. 필드 `token`(secret), 기본 URL `https://skills.altimedia.com/cic/mcp`, 설정 키 `cic.url`. 조립 결과는 `{transport:'http', url, headers:{Authorization:'Bearer <token>'}}`이고, 토큰은 skill-hub와 같은 `normalizeBearerToken`을 지난다. 새 전송 경로도, 새 쓰기 경로도 없다 — 레지스트리 항목 하나가 늘 뿐이다(§2.1의 설계 목적).

**서버 이름은 반드시 `cic`여야 한다.** 아래 내장 서브에이전트가 `tools: mcp__cic__*`로 도구를 지정하고, naby는 MCP 도구를 `<server>__<tool>`로 이름 짓는다(`qualifiedToolName`). 이름을 바꾸면 서브에이전트는 **도구 없이** 돌면서 "Confluence 조사를 못 했다"만 답한다 — 어떤 에러도 남지 않는 실패다. 프리셋 선언과 클라이언트 미러 양쪽에 이 결합을 주석으로 남긴다.

**내장 하네스 번들.** naby는 스킬 `confluence-context`와 서브에이전트 `confluence-researcher`를 **함께 배포한다**. 원문 `.md` 두 개를 `src/runtime/harness-assets/**`에 그대로 두고, 빌드 산출물(`generated.ts`)이 그 문서를 문자열 상수로 번들에 싣는다. 런타임에서 파일을 읽지 않는 이유는 [패키징 경로 해석](packaging-path-resolution.md)이다 — Next(webpack)가 `import.meta.url`을 빌드 머신 경로로 굳히므로 경로 해석 읽기는 이 기계에서만 통과한다. 스파이크가 `.md`를 다시 읽어 상수와 바이트 단위로 대조하므로 사본이 낡을 수는 없다.

**파일이 아니라 행으로 심는다.** 부팅 시 `seedBuiltinHarness`가 없는 항목만 만든다(페르소나 `seedBuiltinPersona`의 부팅-힐과 같은 자리, `getStore`). naby 홈에 파일을 쓰는 대안은 셋을 잃는다 — 사용자가 요청한 적 없는 파일을 홈에 쓰고, 삭제해도 다음 부팅에 되살아나며, 홈 스캔은 도착 즉시 `enabled`를 부여한다(게이트 불변식 7). 이 번들은 그 반대가 필요하다.

**활성화는 cic 자격값에 묶는다.** cic 없이 스킬이 발동하면 서브에이전트가 도구 없이 돌아 자기 실패만 보고한다. 그래서 **토큰 저장이 곧 옵트인**이다.

- 시드는 항상 `disabled`로 들어온다. `systemMcp.set`이 성공하면 프리셋이 선언한 `harnessBundle`을 보고 `applyBuiltinHarnessActivation(store, bundle, true)`, `systemMcp.remove`면 `false`. 액션은 프리셋별 분기를 갖지 않는다(§2.1 불변).
- **사용자가 손으로 끈 것은 다시 켜지 않는다.** 자동 전환은 자기가 마지막에 쓴 값을 `harness.builtin.<name>.autoStatus`에 기록하고, 다음 전환에서 행의 현재 상태와 비교한다. 다르면 사람이 옮긴 것이므로 그 행은 영구히 사용자 소유가 된다. 근거는 하네스가 이미 지키는 원칙과 같다 — 가져오기는 사용자가 끈 것을 이기지 않는다(게이트 불변식 5·7). 자동 스위치가 명시적 선택을 되돌릴 수 있으면 그 선택은 거짓말이 된다.
- 묘비(`removed`)는 건드리지 않는다. `setHarnessEnabled`가 묘비를 되살리기 때문이다(store.ts).
- 부팅 시드는 **없는 것만** 만든다. 사용자가 고친 본문도, 끈 상태도 다시 쓰지 않는다. 대가로 후속 릴리스가 고쳐진 스킬 본문을 기존 설치에 밀어 넣을 수 없다 — 사용자가 편집하도록 초대된 문서 둘에는 옳은 거래이고, 필요해지면 명시적·보고되는 동작으로 따로 만든다.

**스킬은 트리거로 켠다 — 항상-켜짐이 아니다(0.6.1).** `confluence-context` 본문은 1722토큰이라 턴당 스킬 예산 2000의 86%를 혼자 쓴다. 그런데 `skillMatchesTurn`은 트리거가 없는 스킬을 **항상-켜짐**으로 본다(`skill-inject.ts`) — 그대로 두면 사내 위키를 묻는 몇 턴을 위해 나머지 모든 턴이 그 값을 낸다. 그래서 스킬 frontmatter에 `triggers`를 선언하고(생성기가 `tools`와 같은 쉼표 목록으로 파싱해 시드 행의 `skill.triggers`로 넣는다), 사람들이 실제로 치는 호칭 `cic`를 포함한다: `cic, confluence, 컨플루언스, 위키, wiki, adr, 런북, runbook, 사내, 내부 정책, 온콜, oncall, 팀 관행, 관행`. 매칭은 대소문자 무시 **부분 문자열**이므로 `정책`·`에러코드`처럼 일반 코딩 턴에 흔한 낱말은 넣지 않는다 — 오발동의 대가는 잘못된 행동이 아니라 예산이지만, 그 예산이 애초에 이 결정의 이유다.

**도구 이름의 세 철자.** 하나의 도구가 세 이름을 갖는다: 스펙 파일의 `mcp__cic__find_docs`, naby의 `cic__find_docs`, Agent SDK가 보는 `mcp__nabytools__cic__find_docs`(naby가 모든 도구를 자기 인-프로세스 서버 하나로 재노출하므로). 문자 그대로 비교하면 교집합이 비고, 서브에이전트는 도구 없이 돈다. 그래서 매칭은 런타임 `parseToolRefs`/`resolveToolRefs` **하나**가 답한다 — AI-SDK 경로(`restrictToolset`)는 그것으로 거르고, Agent SDK 경로(`sdkAgentTools`)는 거른 뒤 자기 네임스페이스로 다시 수식한다. naby가 갖지 않은 이름(`Grep` 같은 SDK 내장)은 수식하지 않고 그대로 넘긴다. 두 번째 세그먼트만 있는 `mcp__<server>`는 그 서버 전체를 뜻한다.

**원문에서 고친 것.** 두 `.md`는 원문 그대로 두되, naby 안에서 사실이 아닌 부분만 최소로 고쳤다 — 스킬의 설치 도우미가 말하던 `.mcp.json`·`${CIC_HOST}:49820`·healthz 3중 검증은 naby에 없는 절차이므로 System MCP 프리셋 기준 2중 검증으로 바꾸고, 기록 위치 `.claude/confluence.yml`을 `.naby/confluence.yml`로, rating 도구 표기에 naby의 `cic__submit_feedback`을 병기했다. 서브에이전트 `.md`는 무수정이다.

### 2.7.1 두 번째 번들 — atlassian과 `confluence-upload` (0.7.0에서 추가)

**무엇이 늘었나.** skill-hub의 `confluence-upload` 스킬을 세 번째 내장 아티팩트로 싣는다(`src/runtime/harness-assets/skills/confluence-upload/SKILL.md`). 이 스킬은 confUploader 저장소의 로컬 CLI(`build/bin/confupload-cli`)를 셸로 호출해 마크다운을 Confluence 페이지로 올린다 — Markdown을 Storage Format으로, mermaid 블록을 Macro Pack ADF로 변환하는 일이 본체다. 적재 경로는 §2.7 그대로다: 원문 `.md`를 트리에 두고 생성기가 `generated.ts`에 상수로 굳히며, 스파이크가 바이트 단위로 대조한다.

**스위치는 cic가 아니라 atlassian이다.** 이 CLI가 요구하는 값은 `CONFLUENCE_BASE_URL`·`CONFLUENCE_EMAIL`·`CONFLUENCE_API_TOKEN` 셋이고, 이는 atlassian 프리셋이 이미 받는 `CONFLUENCE_URL`·`CONFLUENCE_USERNAME`·`CONFLUENCE_API_TOKEN`과 같은 가족이다. atlassian을 설정한 사용자는 정의상 쓰기 가능한 Confluence 계정과 토큰을 가진 사람이고, cic만 가진 사용자는 **읽기 색인**만 가진 사람이라 페이지를 만들 수단이 없다. 그래서 쓰기 스킬의 옵트인 신호는 atlassian 자격값이다.

주의할 것 하나 — **naby는 저장된 값을 스킬에 넘기지 않는다.** 그 값은 mcp-atlassian stdio 프로세스의 `env`로만 가고, `run_command`는 앱 자신의 환경을 물려받는다. 프리셋은 "이 사용자에게 Confluence 접근권이 있다"는 증거일 뿐 자격값 전달 통로가 아니며, 스킬 본문도 그렇게 말한다.

**규칙을 번들 단위로 일반화한다.** `BUILTIN_HARNESS_BUNDLES`에 `atlassian: ['confluence-upload']` 한 줄이 늘고, 역방향 조회 `bundleOwning(name)`이 표에서 **계산**된다(두 벌을 손으로 맞추지 않는다). 프리셋은 `harnessBundle`을 선언할 뿐이고 `systemMcp.set/remove`는 프리셋별 분기를 여전히 갖지 않는다. 번들 둘은 서로 겹치지 않으며, 한 자격값의 전환은 자기 번들 항목만 움직인다. cic 번들의 동작은 이 변경으로 달라지지 않는다.

**시드 시점 활성화 — 스위치가 닿지 못하는 구멍.** 전환은 자격값을 **저장하거나 제거할 때** 일어난다. 그런데 atlassian 프리셋은 0.2.0부터 있었고 이 스킬은 지금 온다. 이미 설정을 마친 사용자는 다시 저장할 이유가 없으므로 스위치는 영원히 울리지 않고, 행은 꺼진 채로 남는다 — 아무도 켜라고 알려주지 않는 기능이 된다. 그래서 부팅 시드가 `activeBundles`를 받는다.

- 셸의 `configuredHarnessBundles(store)`가 레지스트리를 순회해 **설정된 프리셋의 번들 id**를 모으고, `getStore()`의 시드 호출이 그것을 넘긴다. "이 프리셋이 설정돼 있는가"는 레지스트리를 가진 모듈이 답한다 — 런타임은 설정도 MCP 등록부도 읽지 않는다는 §2.7의 성질을 유지한다.
- 해당 번들 항목은 `enabled`로 도착하고, `harness.builtin.<name>.autoStatus`도 `enabled`로 기록된다. 도착 시점에 행과 기록이 일치하므로 "사용자가 이후에 손댔는가"는 그대로 판정된다 — 시드로 켜진 항목을 사람이 끄면 재저장에도 꺼진 채다.
- **이 가지는 없는 행에만 닿는다.** 이미 있는 행은 그 위의 `findRow` 검사에서 `kept`로 빠지므로, 부팅이 사용자가 끈 것을 되켜는 뒷문이 될 수 없다.
- cic는 이 파라미터로 달라지지 않는다. cic 프리셋과 cic 행은 같은 릴리스(0.6.0)에서 함께 왔으므로 "자격값은 있는데 행이 없는" 설치가 존재할 수 없고, 시드는 언제나 `kept`로 끝난다. 그래서 호출부는 프리셋별 예외 없이 **설정된 번들 전부**를 넘긴다.

**트리거.** 매칭은 대소문자 무시 부분 문자열이므로 낱말 선택이 곧 발동 정책이다. 최종 목록은 `confluence, 컨플루언스, 컨플, confupload, atlassian.net`이다.

- `컨플`은 `컨플루언스`의 부분집합이면서 "컨플에 올려줘" 같은 준말도 잡는다. `confupload`는 CLI·저장소 이름이라 오발동이 사실상 없다. `atlassian.net`은 사용자가 부모 페이지 URL을 붙여넣은 턴을 잡는다 — 제품명을 한 번도 말하지 않는 가장 흔한 업로드 요청이다.
- **`업로드`/`upload`는 넣지 않았다.** 코퍼스로 재봤다: 코딩 에이전트의 평범한 턴 8개(파일 업로드 API, `s3 uploadFile` 실패, 이미지 업로드 컴포넌트, multipart upload 리뷰, 리팩터링, 테스트 실패, 변수 이름 바꾸기, 사내 위키 검색) 중 **4개**가 그 두 낱말만으로 발동한다. 발동 대가는 잘못된 행동이 아니라 1106토큰이지만, 그 예산이 애초에 이 결정의 이유다. 최종 목록으로는 8개 중 0개가 발동한다.
- **`위키`/`wiki`도 넣지 않았다.** 그 낱말이 붙는 문장은 대개 조사 요청("사내 위키에서 찾아줘")이라 `confluence-context`의 몫이고, 업로드 스킬까지 끌어오면 조사 턴이 쓰기 문서를 이고 간다.

**예산 — 원문은 그대로는 실릴 수 없었다.** skill-hub 원문(265줄)의 주입 블록은 **2585토큰**이고, 당시 턴당 스킬 예산은 2000이었다. `selectSkillsForInjection`은 한 스킬의 비용이 남은 예산을 넘으면 그 스킬을 **통째로 버리고 센다**(`droppedForBudget`) — 즉 원문 그대로 실었다면 매칭되는 모든 턴에서 버려지는 **영원히 주입 불가한 죽은 행**이 된다. 그래서 압축이 선행 조건이었고, naby 전용 본문은 **1106토큰**이다(57% 감축).

**예산을 2000에서 3000으로 올린다.** 두 내장 스킬은 `confluence`·`컨플루언스`를 **둘 다** 트리거로 갖는다 — 둘 다 Confluence에 관한 것이니 당연하고, 피할 방법도 없다. 합은 1722+1106=**2828**이라 2000에는 들어가지 않는다. 그런데 `skill-inject`의 순위는 스코프 → 최신순일 뿐 **적합도 신호가 없어서**, 어느 쪽이 살아남는지는 요청 내용이 아니라 시드 순서가 정한다. 실측 결과 200회 시드 전부에서 `confluence-context`가 이겼다 — 즉 "이 md 컨플루언스에 올려줘" 턴이 조사 스킬만 받고 업로드 스킬을 잃는다. 그 상태의 모델은 mcp-atlassian의 페이지 생성으로 손을 뻗고, 표와 mermaid가 조용히 깨진 페이지가 남는다. **예산은 할당량이 아니라 상한**이므로 올려도 매칭이 적은 턴에서는 한 토큰도 더 쓰지 않는다. 추가분은 Confluence를 지명한 턴에서만 쓰이고, 그 턴이 바로 둘 다 필요한 턴이다.

**스킬은 도구를 요구한다.** `confluence-upload`의 frontmatter는 `tools: run_command`를 선언한다 — `confluence-context`가 `toolRefs`를 갖지 않는 것과 반대이며, 이유도 반대다. 이 스킬은 CLI를 **실행**해서 일을 하므로, 셸이 없는 턴(프로젝트가 열리지 않은 세션에는 `run_command` 실행기가 등록되지 않는다)에 1106토큰짜리 실행 안내를 넘기는 것은 낭비다. `skill-inject`는 그런 턴에서 이 스킬을 붙잡고 **센다**(`excludedForTools`).

**원문에서 고친 것(전부).** naby 안에서 참이 아닌 문장만 고쳤고, 나머지 감축은 위의 예산 때문이다.

1. `AskUserQuestion` — 원문은 토큰 수집(§토큰 처리)과 모드 결정(§Step 3)에서 그 도구를 지시한다. naby는 SDK의 그 도구를 **의도적으로 거부한다**(`NATIVE_ASK_USER_QUESTION_TOOL`, 체크인 원장이 비는 것을 막기 위해서다). 답변 본문으로 직접 묻고, 되돌리기 어려운 선택은 `naby_checkin`으로 물어 원장에 남기도록 바꿨다.
2. "Claude Code의 `Bash` 도구는 셸 상태가 호출 간 유지되지 않는다" — naby의 도구는 `run_command`이고, 매 호출 새 셸을 띄우므로 상태가 유지되지 않는다는 **결론은 같지만 이름이 틀렸다**. 도구 이름을 고치고, 같은 이유로 `cd`도 이어지지 않는다는 사실을 더했다.
3. 작업 디렉터리 — 원문은 "다른 디렉터리면 사용자에게 `cd /path/to/confUploader`를 안내하고 중단"한다. naby에서 cwd는 **열린 프로젝트로 고정**되고 사용자가 셸에서 옮길 수 있는 것이 아니다. confUploader를 프로젝트로 열든지, 한 호출 안에서 `cd … && …`로 묶든지 둘 중 하나로 바꿨다.
4. 자격값 출처 — 원문은 "셸 env에 없으면" 사용자에게 받으라고 한다. naby의 `run_command`는 앱 환경을 물려받으므로 그 값이 있을 이유가 거의 없고, **설정의 atlassian 프리셋에 같은 값이 있어도 이 셸에는 실리지 않는다**는 사실을 명시했다.
5. 실행 한계 — naby에만 있는 두 제약을 더했다. `run_command`의 기본 타임아웃은 60초(최대 600초)라 파일이 여러 개면 `--delay-ms` 때문에 쉽게 넘고, 명령 출력은 3만 자에서 잘리므로 `--dry-run-emit-body`는 파일로 받아야 한다.
6. `## Reference` 절 — 원문은 `../README.md` 같은 **스킬 폴더 상대 경로**를 가리킨다. naby의 스킬은 파일이 아니라 행이라 그 경로가 존재하지 않으므로 절을 삭제했다.
7. frontmatter `allowed-tools: Bash, Read, AskUserQuestion` → naby의 이름으로 바꾸고(`run_command`), 생성기가 파싱하는 `tools:` 키를 함께 두어 위의 도구 게이팅을 켰다.

압축으로 **덜어낸 것**(내용 손실을 명시한다): mcp-atlassian 비교표 7행(라우팅 규칙은 frontmatter `description`에 남아 있고, `description`은 주입 블록에 실리지 않아 예산을 쓰지 않는다), 모드 표 6행 → 산문 한 문단, 선택 플래그 10개 → 자주 쓰는 6개 + `--help` 안내, 예제 3개 → 실행 예 1개, JSON Lines 예시 3줄 → 필드 목록 한 줄, Troubleshooting 표 10행 → 5행(구버전 바이너리가 원인인 3행을 한 행으로 합쳤다), Security notes 4줄 → 자격값 절의 2문장, Anti-patterns 4줄 → 실패 절의 2행. **줄이지 않은 것**: mermaid 안정 문법 규칙과 자동 교정의 한계, 표 셀 `|` 이스케이프, 참조 링크·평문 URL 변환 — `--help`로 대체되지 않고 문서를 **쓸 때** 필요한 지식이라 이 스킬의 실제 값어치다.

## 3. 검증 계획

- 자동 활성화(§2.5, 0.5.0) — 스파이크 `spike:harness`에 게이트 불변식 7 검사를 넣는다(신규 naby 홈 행은 enabled·enabled 전용 목록에 보임, 플래그 없으면 disabled, 벤더는 disabled, 사용자가 끈 행은 재스캔에도 꺼진 채, 묘비·신뢰 순서 불변). 셸에서는 임포터가 **어떤 아티팩트에 플래그를 다는지**(요청 수준)와 라우트 설치 플로우(파일 등장 → 목록 → 클릭 없이 enabled 목록에 보임, 킬 스위치 끄면 disabled)를 검증한다.
- 셸 vitest — 레지스트리 조립(정규화·Bearer 중복 방지·URL 덮어쓰기·Atlassian env 조립·uvx 해석 실패 거부), `systemMcp.set/test/remove` 액션(필수 필드 누락 거부, 응답에 secret 미포함 — set/test/remove/GET 전 경로 직렬화 검사), 상태 판정, 일반 목록의 프리셋 필터.
- cic 프리셋(§2.7) — 셸 vitest에 토큰 없으면 거절, 토큰 하나로 HTTP 엔트리 조립, `Bearer` 한 번만, URL 덮어쓰기, **응답에 토큰이 실리지 않음**(비밀 필드가 하나뿐이라 `readNonSecretFields`가 빈 객체), 서버 이름이 `cic`임을 넣는다. 상태 판정 테스트는 하드코딩 대신 레지스트리를 순회하도록 바꾼다 — 네 번째 프리셋이 이 케이스를 자동으로 받는다. 테스트의 토큰은 항상 자리표시 문자열이다.
- 내장 번들(§2.7) — 스파이크 `spike:harness-seed`가 (a) `generated.ts`와 `.md` 원문의 바이트 일치, (b) 시드는 disabled·재부팅 무동작·편집분 미덮어쓰기·삭제분 미부활, (c) cic 저장 → 활성, 제거 → 비활성, **사용자가 끈 것은 재저장·재연결에도 꺼진 채**, 묘비 미부활, (d) `mcp__cic__*` → `cic__*` 매칭과 그 밖의 도구 차단, (e) Agent SDK 경로의 `mcp__nabytools__cic__*` 재수식, (f) 트리거 게이팅(시드 행이 `triggers`를 갖는다, "cic에서 배포 정책 찾아줘"·"그 서비스 ADR 어디 있어" 류는 매칭되고 "이 함수 리팩터링해줘" 류는 매칭되지 않는다, 무관한 턴의 스킬 예산 소모가 0이다)을 검사한다. 셸 vitest는 같은 전환을 실제 스토어로 다시 돌리고, `restrictToolset`의 세 철자 처리를 따로 검증한다.
- 두 번째 번들(§2.7.1) — 같은 스파이크에 (g)와 (h)를 더한다. (g)는 번들 둘이 겹치지 않고 모든 아티팩트가 정확히 한 번들에 속한다는 것, atlassian 저장/제거가 자기 항목만 움직이고 cic 항목은 건드리지 않는다는 것, `activeBundles`로 시드하면 켜진 채 도착하고 설정되지 않은 번들은 꺼진 채 온다는 것, 그렇게 켜진 항목을 사람이 끄면 재저장에도 꺼진 채라는 것, 인자를 주지 않으면 예전 그대로라는 것을 본다. (h)는 트리거 코퍼스(업로드 요청 5개 전부 매칭, 미끼 8개 전부 비매칭, `업로드`/`upload`를 넣으면 미끼 4개가 매칭)와 예산(단독 1106 ≤ 예산, 두 스킬 합 2828이 실제 셸 예산 안에 들어감, 2000에서는 하나가 버려짐, `run_command`가 없는 턴은 `excludedForTools`로 집계)을 본다. **예산 숫자는 셸 소스에서 읽는다** — 상수를 다시 적으면 셸에서 낮춰도 여기서는 통과한다. 셸 vitest는 같은 전환을 실제 스토어로 다시 돌리고, `configuredHarnessBundles`가 레지스트리를 순회한다는 것을 따로 본다.
- 회귀 — 셸 전체, 타입체크 양 트리, `build:app`.
- 미검증 — 실제 서버와의 라이브 연결(자격값 필요), 온보딩 시각 렌더, 패키징본에서의 uvx 경로 해석, **실제 모델이 스킬 발동 판단을 옳게 하는지**(프롬프트 품질은 스파이크의 대상이 아니다). `confupload-cli`의 실제 동작도 미검증이다 — naby는 그 저장소를 갖고 있지 않고, 스킬 본문의 CLI 계약(플래그·JSON Lines·종료코드)은 skill-hub 원문을 그대로 믿는다.

## 4. 미결정

- 온보딩 스텝의 노출 조건. 1차는 항상 노출(건너뛰기 가능)로 시작한다. 사내 배포가 아닌 사용자에게 숨길지는 배포 대상이 넓어질 때 정한다.
- 토큰 만료/401의 사용자 알림. 지금은 턴 로그의 연결 실패 경고뿐이다 — 프리셋 행의 테스트 버튼이 1차 진단 수단이다.
- Atlassian Jira env(JIRA_URL 등) 추가와 stdio 서버의 턴별 프로세스 스폰 비용(현재 MCP는 턴마다 연결·해제 — stdio 프리셋이 늘면 캐싱을 검토한다).
- uvx 미설치 사용자를 위한 자동 설치 안내(또는 동봉). 1차는 저장 거부 + 안내 문구다.
