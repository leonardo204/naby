---
name: confluence-upload
description: 마크다운 파일을 Confluence Cloud 페이지로 올릴 때 발동한다 — confUploader의 CLI를 호출해 Markdown을 Storage Format으로, mermaid 블록을 Macro Pack ADF로 변환한다. `.md`에 표·코드펜스·체크박스·참조 링크·mermaid가 있으면 특히 이 경로로 올린다. mcp-atlassian의 confluence_create_page는 Markdown→Storage Format 변환도 Mermaid→Macro Pack 변환도 하지 않아 그대로 깨지므로, 마크다운 본문 업로드는 이 스킬이 맡는다. 페이지 조회·검색·댓글·라벨은 mcp-atlassian이 맡는다.
allowed-tools: run_command
tools: run_command
triggers: confluence, 컨플루언스, 컨플, confupload, atlassian.net
---

# confluence-upload — 마크다운을 컨플루언스 페이지로

confUploader 저장소의 CLI(`build/bin/confupload-cli`)를 `run_command`로 호출해 `.md`를 Confluence Cloud로 올린다. `.md` 본문을 페이지로 만드는 일은 이 스킬이, 페이지 조회·검색·댓글·라벨은 mcp-atlassian이 맡는다.

## naby에서의 실행 조건

- **작업 디렉터리는 열린 프로젝트로 고정된다.** `run_command`는 호출마다 새 셸을 띄우므로 `cd`도 `export`도 다음 호출로 이어지지 않는다. confUploader를 프로젝트로 열었으면 그대로 쓰고, 아니면 한 호출 안에서 `cd /path/to/confUploader && ...`로 묶는다. 저장소 경로를 모르면 **묻고, 답을 받기 전에는 실행하지 않는다.**
- **환경변수는 매 호출 인라인으로 전달한다** (`CONFLUENCE_API_TOKEN='...' ./build/bin/confupload-cli ...`).
- **설정의 atlassian 프리셋에 같은 자격값이 있어도 이 셸에는 실리지 않는다.** 그 값은 mcp-atlassian 프로세스로만 간다. 여기서 쓸 값은 따로 받는다.
- **묻는 방식**: naby에는 `AskUserQuestion` 도구가 없다. 답변 본문으로 직접 묻는다. 되돌리기 어려운 선택(예: `children-overwrite`)은 `naby_checkin`으로 물어 원장에 남긴다.
- `run_command` 기본 타임아웃은 60초다. 파일이 여러 개면 파일 간 지연(`--delay-ms`) 때문에 쉽게 넘으므로 `timeoutMs`를 올리거나(최대 600000) 5~10개씩 나눠 올린다.
- 명령 출력은 3만 자에서 잘린다. `--dry-run-emit-body`는 파일로 리다이렉트해 필요한 부분만 본다.

## 자격값

`CONFLUENCE_BASE_URL`(`https://<회사>.atlassian.net`), `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`(발급: https://id.atlassian.com/manage-profile/security/api-tokens). 대화에 이미 있으면 다시 묻지 않는다. 처음 받을 때 **채팅 기록에 평문으로 남는다는 점을 한 줄 알린다.** 받은 값은 어떤 파일에도 저장하지 않는다.

## 절차

1. **사전 점검을 한 호출로 묶는다.**
   ```bash
   cd /path/to/confUploader && pwd && grep -q "module confupload" go.mod && echo REPO_OK
   test -x build/bin/confupload-cli && echo BIN_OK || echo NEED_BUILD
   ```
   `go.mod`가 없거나 모듈명이 다르면 중단하고 저장소 경로를 묻는다. 바이너리가 없으면 빌드하겠다고 알린 뒤 `go build -o build/bin/confupload-cli ./cmd/confupload-cli`를 한 번 돌린다(이후로는 캐시된다).
2. **파일 경로와 부모 페이지 URL을 확보한다.** 부모 URL이 없으면 묻는다.
3. **모드를 고른다.** `direct`는 부모 페이지 본문 자체를 단일 파일로 교체한다(제목·자식·첨부·댓글은 보존). `children`은 부모 아래 자식 페이지로 새로 만든다. `children-skip`은 같은 제목을 건너뛰어 재실행이 안전하다. `children-overwrite`는 같은 제목 페이지를 **자식·첨부·이력까지 지우고** 다시 만든다. 기본 추천은 단일 파일이면 `direct`, 여러 개면 `children-skip`이고, `children-overwrite`는 사용자가 명시적으로 원할 때만 쓴다.
4. **실행한다.**
   ```bash
   CONFLUENCE_BASE_URL='<url>' CONFLUENCE_EMAIL='<email>' CONFLUENCE_API_TOKEN='<token>' \
   ./build/bin/confupload-cli upload --parent-url='<부모 페이지 URL>' --mode=children-skip a.md b.md
   ```
   플래그 전체는 `./build/bin/confupload-cli upload --help`로 본다. 자주 필요한 것만:
   - `--unique-title=false` — 기본값 `true`는 제목 앞에 `(YYYY-MM-DD 동물이름) ` prefix를 붙인다. "제목 앞에 이상한 게 붙었다"는 항상 이 플래그다(`direct`에는 영향 없음).
   - `--dry-run` — Confluence 호출 없이 변환만 검증한다.
   - `--mermaid-fallback` — Macro Pack이 없는 인스턴스에서 mermaid를 코드 블록으로 내린다(이때 아래의 자동 교정은 적용되지 않는다).
   - `--mermaid-extension-key=<키>` — 인스턴스마다 Macro Pack 키가 다를 때. "macro not found"의 해법이다.
   - `--delay-ms=8000` — HTTP 429가 자주 뜰 때.
   - `--space=KEY --parent-id=ID` — `--parent-url` 대신 직접 지정.

   진단은 `./build/bin/confupload-cli setup [--test]`(토큰은 마스킹된다).
5. **결과를 읽는다.** stdout은 JSON Lines다. 파일마다 `{"file","title","status","url","message"}`(status: `success`/`skipped`/`failed`/`dry-run`), 마지막에 `{"summary":{...}}`. 종료코드는 0=전부 성공, 1=실패 1건 이상, 2=인자/env 오류. 성공 URL 목록과 실패 파일+메시지를 사용자에게 그대로 보여준다.

## 문서를 쓸 때 지켜야 변환이 깨지지 않는 것

- **표 셀 안의 리터럴 `|`는 `\|`로 이스케이프한다.** 안 하면 파서가 셀을 하나 더 만들어 그 행 전체가 밀린다(`| flag | TRUE\|FALSE | 설명 |`). 의미가 유지되면 `/`나 `&#124;`로 바꿔도 된다. 구분자 행은 셀당 대시 1개면 충분하고 정렬 마커(`:-:`)도 된다. 놓친 `|`가 있으면 CLI가 `warning: table row has N cells but header has M …`로 그 행을 지목한다.
- **참조 링크와 평문 URL은 CLI가 살려낸다.** `[텍스트][label]`, `[label]` 단축형, `[label]: url` 정의 줄, 맨 `https://…` 모두 클릭 가능한 링크가 된다. Confluence Storage Format은 평문 URL을 자동으로 링크화하지 않으므로, **이 경로를 거치지 않으면 References 절의 링크가 전부 죽는다.** 각주만 남기고 정의 줄을 지우지 않는다. 코드펜스 안의 정의·URL과 정의 없는 `[대괄호]`·`[x]` 체크박스는 건드리지 않는다.
- **mermaid는 최신 문법이 아니라 안정 문법으로 쓴다.** 라벨은 항상 `A["텍스트"]`처럼 큰따옴표로 감싼다. 라벨 안에 소괄호를 쓰지 않는다(노드 모양으로 오해석되므로 엠대시나 쉼표로 푼다). 줄바꿈은 `<br>`이고 `\n`이 아니다. 라벨 안에 `#`·`**`·백틱을 넣지 않는다. 넘버링은 숫자(`1.`)가 아니라 문자(`A.`)로 한다. 한 다이어그램의 노드는 15개를 넘기지 않는다.
- CLI는 flowchart/graph에 한해 위 규칙을 업로드 직전에 **자동 교정**하고 stderr `warning`으로 알린다. 다만 **노드 15개 초과는 자동 분리가 안 되므로**, 그 경고가 뜨면 문서의 다이어그램을 서브 다이어그램으로 직접 쪼갠 뒤 다시 올린다. sequence·gantt 등은 자동 교정 대상이 아니다. 자동 교정은 안전망일 뿐이므로 새 문서는 처음부터 규칙대로 쓴다.

## 자주 나오는 실패

- `status:"failed"` + `title already exists` → `--mode=children-skip`, 또는 정말 지워도 되면 `children-overwrite`.
- `direct`인데 "단일 파일만 지원" → 파일을 하나로 줄이거나 `--mode=children`.
- exit 2 + stderr에 `CONFLUENCE_*` 변수명 → 인라인 전달이 빠졌다. 앞 호출의 `export`가 남아 있다고 가정하지 않는다.
- 표가 날것의 `|`로 렌더되거나, mermaid가 사각형 텍스트로 깨지거나, References 링크가 죽어 있으면 대개 구버전 바이너리다. 재빌드한다.
- 한 번에 50개 이상을 요구받으면 5~10개씩 나눠 올린다. 429가 나면 전체가 더 길어진다.
