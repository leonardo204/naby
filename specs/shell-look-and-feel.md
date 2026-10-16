---
id: shell-look-and-feel
title: 셸 룩앤필 — 프로토타입 팔레트를 토큰으로 옮긴다
type: design
version: 0.2.1
status: review
scope: naby 셸(cockpit)의 색·모서리·그림자·글꼴을 대화형 다중 에이전트 프로토타입(`demo/multi-agent-chat/index.html`)에 맞추는 설계. 토큰 교체, 하드코딩 상태색 이관, 표면별 모양 변경, HTML 출력 스타일 동기화, 스크린샷 검증을 다룬다. multi-agent-chat R7의 설계이고 마일스톤 MAC-M0다. 참가자 UI 자체(명단·말풍선 발언자·승인 카드의 동작)는 multi-agent-chat이 맡는다.
related: [multi-agent-chat, settings-ia-reorg, packaging-path-resolution]
updated: 2026-10-16
---

# 셸 룩앤필 — 프로토타입 팔레트를 토큰으로 옮긴다

> 이 문서가 답하는 질문 — **"프로토타입의 보라 계열 룩앤필을 실제 셸에 입히려면 어느 파일의 무엇을 바꾸고, 바뀌지 않는 곳은 어디이며, 끝났다는 것을 어떻게 아는가?"**
>
> 상태: 설계(2026-10-16). [multi-agent-chat](multi-agent-chat.md) §4.7 R7과 D14·D15의 설계다. 구현은 Opus 에이전트가 한다.

## 1. 원칙

1. **색은 토큰만 바꾸면 된다.** 셸은 Tailwind v4 `@theme inline`으로 `globals.css`의 CSS 변수를 유틸리티에 연결한다. 토큰 클래스가 약 2,140곳, 하드코딩 팔레트 클래스가 406곳이다. 토큰 값을 바꾸면 사이드바·설정·말풍선·작성기·상태 바가 함께 바뀐다. 컴포넌트를 돌며 색을 바꾸는 작업이 아니다.
2. **하드코딩 상태색은 이번에 없앤다.** 406곳의 거의 전부가 red·amber·emerald 상태색이고 15개 파일에 몰려 있다. 토큰으로 옮기면 `dark:` 쌍도 같이 사라진다. 이 작업을 미루면 새 팔레트 위에 옛 상태색이 섞인다.
3. **표면 모양은 참가자 UI가 만지는 곳만 바꾼다.** 말풍선·헤더·설정 nav·승인 카드·사이드바 라벨이다. git·diff·터미널·기억·하네스 패널은 토큰 변경만 반영되고 재설계하지 않는다.
4. **테마 전환 구조는 건드리지 않는다.** `.dark` 클래스, `boot.js`의 선페인트 스탬프, `ThemeProvider`, 설정의 시스템/라이트/다크 선택은 그대로다.
5. **이 변경은 독립 릴리스다**(D15). 참가자 기능보다 먼저 나간다. 릴리스 노트 항목을 쓴다([packaging-path-resolution](packaging-path-resolution.md) §4 0단계).

## 2. 현황 (확인한 사실)

- `shell/src/app/globals.css`: `:root`(17행~)에 Radix 스케일(teal 12단계, slate 12단계, red·green·amber·orange·violet·blue는 9~11 세 단계만)과 의미 토큰이 HSL 삼중항으로 있다. `.dark`(138행~)가 같은 이름을 덮는다. `@theme inline`(228행~)이 `--color-*`로 등록한다. `--radius: 0.5rem`이고 `--radius-sm/md/lg/xl`이 거기서 파생된다(315행~).
- 의미 토큰: `background` `foreground` `card` `card-foreground` `popover` `popover-foreground` `primary` `primary-foreground` `secondary` `secondary-foreground` `muted` `muted-foreground` `accent` `accent-foreground` `destructive` `destructive-foreground` `border` `input` `ring` `brand` `brand-foreground` `success` `warning`. `primary`는 slate-12(중립)라 라이트에서 버튼이 거의 검정이다. `brand`·`ring`은 teal-9다.
- 글꼴: `--app-font-sans`·`--app-font-mono`는 사용자 설정(`packages/shared/utils/src/fontSettings.ts`의 프리셋 `system` · `pretendard` · `noto-sans-kr` · `custom`)이 정한다. 기본 `system` 스택은 `var(--font-inter), -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "PingFang SC", "Microsoft YaHei", sans-serif`다. Inter·Lora·JetBrains Mono는 `layout.tsx`의 `next/font`로 들어온다.
- 그림자 토큰은 없다. `.toast-surface`만 자체 그림자를 가진다(447행~).
- `public/html-lib/theme.css`는 HTML 출력용 별도 스타일로, 같은 토큰 이름을 `hsl(...)`로 감싼 값으로 따로 갖고 있다. 동기화가 필요하다.
- 아이콘은 lucide-react다. 바꾸지 않는다.
- 하드코딩 팔레트 클래스 상위 파일: `NabyProviderSetup.tsx`(39) · `nabyScope.tsx`(12) · `NabyHarnessReview.tsx`(12) · `NabyOrgHarnessSettings.tsx`(10) · `DiffDocument.tsx`(10) · `GitPanel.tsx`(9) · `MemoryBrowserModal.tsx`(7) · `ScheduledTasksPanel.tsx`(7) · `ToolApprovalPrompt.tsx`(12). 색 계열은 red-500(82) · amber-500(48) · amber-400(39) · amber-600(37) · red-600(23) · red-400(22) · emerald(약 43)다. `.tsx` 안 hex 리터럴은 약 130개다.

## 3. 토큰 설계

### 3.1 스케일 — violet을 brand 스케일로

teal 스케일은 지우지 않는다(다른 곳에서 `teal-N`을 직접 쓰는 곳이 있을 수 있다). 지금 violet은 9~11 세 단계뿐이고 값(`252 56% 57%`)도 프로토타입과 다르다. **violet 스케일 12단계를 새로 정의한다.** 라이트 violet-9는 프로토타입 `--pri`(`#6D4AFF`, `252 100% 65%`), violet-10은 `--pri2`(`#9B7BFF`, `255 100% 74%`)이고, 다크 violet-9는 `#9B7BFF`, violet-10은 `#C3B0FF`다. 나머지 단계는 Radix violet 12단계의 명도 간격을 따라 이 두 값에 맞춰 채운다. **순서가 중요하다.** violet 스케일을 먼저 정의하고, 그다음 §3.2의 `--primary`·`--brand`가 violet-9를 가리키게 한다. 기존 violet-9를 그대로 둔 채 `--primary`만 옮기면 §3.2 표의 hex가 거짓이 된다. 실제 값은 구현할 때 정하고 §6 스크린샷으로 판정한다.

### 3.2 의미 토큰 값

HSL 삼중항이다(셸 관례). 변환은 프로토타입 hex에서 했다.

| 토큰 | 라이트 | 다크 | 프로토타입 출처 |
|---|---|---|---|
| `--background` | `0 0% 100%` | `232 15% 11%` | `--bg` |
| `--sidebar` **(신설)** | `240 23% 97%` | `231 16% 9%` | `--side` |
| `--card`, `--popover` | `0 0% 100%` | `233 14% 13%` | `--card` |
| `--foreground`, `--card-foreground`, `--popover-foreground` | `230 10% 12%` | `230 21% 95%` | `--ink` |
| `--muted-foreground` | `225 7% 45%` | `227 10% 64%` | `--sub` |
| `--border`, `--input` | `230 14% 91%` | `230 12% 19%` | `--line` |
| `--muted`, `--secondary` | `228 24% 96%` | `229 14% 15%` | `--soft` |
| `--accent` | `254 100% 96%` | `254 31% 20%` | `--chip` |
| `--accent-foreground` | `var(--violet-11)` | `var(--violet-11)` | 칩 글자 |
| `--primary` | `var(--violet-9)` | `var(--violet-9)` | `--pri` — 기본 버튼이 보라가 된다 |
| `--primary-foreground` | `0 0% 100%` | `253 47% 10%` | `--onpri` |
| `--brand`, `--ring` | `var(--violet-9)` | `var(--violet-9)` | `--pri` |
| `--brand-foreground` | `var(--violet-11)` | `var(--violet-11)` | |
| `--brand-2` **(신설)** | `255 100% 74%` | `254 100% 85%` | `--pri2`, 그라데이션 끝 |
| `--user-bubble` **(신설)** | `252 100% 65%` | `251 41% 39%` | `--ubub` |
| `--user-bubble-foreground` **(신설)** | `0 0% 100%` | `253 100% 96%` | `--uink` |
| `--success` | `159 80% 35%` | `157 63% 53%` | `--ok` |
| `--warning` | `38 95% 39%` | `38 90% 61%` | `--warn` |
| `--destructive` | `0 73% 55%` | `0 100% 71%` | `--bad` |
| `--info` **(신설)** | `var(--blue-9)` | `var(--blue-9)` | 하드코딩 blue 이관용 |
| `--code-surface` **(신설)** | `240 16% 96%` | `229 14% 15%` | `--code` |

`--secondary-foreground`·`--destructive-foreground`는 그대로다. `success`·`warning`·`info`에는 `-foreground` 짝을 만든다(흰색 또는 `--foreground`).

### 3.3 모서리·그림자

- `--primary`가 중립(slate-12)에서 보라로 바뀐다. `bg-primary`를 중립 버튼으로 쓰는 곳이 있으면 `bg-secondary`로 옮긴다. 사용처는 `grep -rn 'bg-primary' shell/packages`로 MAC-M0.3 전에 점검한다.
- `--radius: 0.75rem`(12px). 파생은 그대로 두되 `--radius-xl`을 `calc(var(--radius) + 4px)`(16px)로 유지한다. 프로토타입의 카드 14~16px, 칩 8px, 입력 10px가 `rounded-xl` · `rounded-md`(`calc(12px - 2px)` = 10px) · `rounded-sm`(8px)에 맞는다. 셸 안에서 `rounded-*` 클래스를 바꾸지 않아도 된다.
- `--shadow-card`(신설): 라이트 `0 2px 14px rgba(30,25,80,.08)`, 다크 `none`. `--shadow-float`(신설, 모달·팝오버): 라이트 `0 30px 80px rgba(30,25,80,.18)`, 다크 `0 30px 80px rgba(0,0,0,.55)`. `@theme inline`에 `--shadow-card`·`--shadow-float`로 등록해 `shadow-card`·`shadow-float` 유틸리티로 쓴다. `.toast-surface`의 자체 그림자는 `--shadow-float`로 바꾼다.
- 브랜드 그라데이션은 토큰이 아니라 유틸리티 한 개다: `.bg-brand-gradient { background: linear-gradient(135deg, hsl(var(--brand)), hsl(var(--brand-2))) }`. 로고·기본 버튼·사용자 말풍선 강조에만 쓴다.

### 3.4 글꼴 (D14)

Inter는 유지한다. `fontSettings.ts`의 `system` 스택에서 `"Apple SD Gothic Neo"` 뒤에 `"Pretendard Variable", Pretendard`를 넣는다. 설치돼 있으면 쓰고 없으면 다음으로 넘어가므로 글꼴 파일을 받지 않는다. `boot.js`·`layout.tsx`는 스택을 `fontSettings`에서 읽으므로 그 파일만 고치면 된다. `pretendard` 프리셋은 그대로다.

## 4. 하드코딩 상태색 이관

규칙은 셋이다.

1. 의미가 오류·위험이면 `destructive`, 주의·보류면 `warning`, 성공·연결됨이면 `success`, 안내·정보면 `info`로 옮긴다. `text-red-500 dark:text-red-400` 같은 쌍은 `text-destructive` 하나가 된다.
2. 배경 틴트(`bg-amber-50 dark:bg-amber-950/30`)는 `bg-warning/10` 같은 알파 유틸리티로 옮긴다. Tailwind v4는 `hsl(var(--warning) / 0.1)`을 `bg-warning/10`으로 만든다.
3. 색이 **의미가 아니라 식별**(예: 스코프 배지의 violet·blue)이면 `brand`·`info`로 옮기되, 두 가지 이상 식별색이 필요하면 `--chart-1..4` 같은 식별 토큰을 그때 신설한다. 임의 팔레트를 남기지 않는다.

대상 파일은 §2의 상위 9개와 `grep -rnE '(bg|text|border|ring)-(red|amber|emerald|green|violet|blue|orange)-[0-9]{3}' shell/packages/feature`가 찾는 나머지다. 완료 기준은 **상태색 계열(red·amber·emerald·green) 0건**이다. hex 리터럴 약 130개는 `.tsx`에서 `grep -rn '#[0-9a-fA-F]\{6\}'`로 찾아 색이면 토큰으로, 아바타 색처럼 데이터면 남긴다.

## 5. 표면별 모양 (R7.3) — 8개

프로토타입의 단계를 시각 기준으로 적는다. 동작은 multi-agent-chat이 정한다.

| 표면 | 파일 | 바꾸는 것 | 프로토타입 기준 |
|---|---|---|---|
| 사용자 말풍선 | `feature/agent/src/client/MessageBubble.tsx` | `bg-user-bubble text-user-bubble-foreground`, 오른쪽 정렬, `rounded-xl` | 시나리오 3 1단계 |
| 에이전트 말풍선 | 같은 파일 | 아바타(이모지 또는 이미지)·이름 줄 + `bg-card border` 카드. ~~나비는 지금처럼 아바타 없이 평문 유지~~ **2026-10-16 개정(사용자 피드백)**: 나비도 같은 카드 모양이다. 머리줄에 나비 아바타(`NabyAvatar`, 귀여운 나비 SVG, 브랜드 그라데이션)와 이름, 강조색은 브랜드 | 시나리오 3 2단계 |
| 채팅 헤더 | `feature/agent/src/client/ChatHeader.tsx` | 세션 제목 아래 보조 줄, 오른쪽에 명단 자리(M3에서 채움)와 토글 영역 | 시나리오 2 |
| 작성기 | `feature/agent/src/client/ChatInput.tsx` | `bg-card border rounded-xl`, 보내기 버튼 `bg-brand-gradient` 원형 | 모든 시나리오 |
| 승인 카드 | `feature/agent/src/client/ToolApprovalPrompt.tsx` | `border-brand/40 bg-card`, 제목 칩 `bg-accent text-accent-foreground`, 승인 버튼 `bg-primary` | 시나리오 4 2단계 |
| 사이드바 | `feature/workspace/src/client/ProjectSidebar.tsx` | `bg-sidebar`, 섹션 라벨(`text-muted-foreground text-xs`) "프로젝트"/"세션", 선택 행 `bg-accent` | 모든 시나리오 왼쪽 |
| 설정 모달 | `feature/workspace/src/client/SettingsModal.tsx` | 왼쪽 세로 nav(선택 항목 `bg-accent text-brand-foreground`), 본문 `bg-card`, `shadow-float` | 시나리오 1·5 |
| 상태 바·토스트 | `ConnectionStatusBar.tsx`, `shared/ui/Toast.tsx` | 토큰만 따라감. 토스트 그림자를 `shadow-float`로 | — |

## 6. 검증

1. **정적**: `cd shell && npm run typecheck`(기준선 오류만), `npm test`(전부 통과, 색은 동작 테스트에 안 걸린다). §4의 grep이 status 계열 0건.
2. **스크린샷**: prod 빌드 서버(`node server.mjs`, distDir `.next-prod`)를 띄우고 Playwright(이미 설치됨)로 라이트·다크 각 6화면을 찍는다 — 채팅(나비 답변 포함) · 설정 일반 · 설정 나비 · 도구 승인 카드 · 사이드바가 보이는 전체 창 · 활동 로그가 있으면 그 화면(없으면 기억 탭). 스크립트는 `shell/scripts/ui-screenshots.mjs`로 두고 출력은 스크래치 디렉터리다(저장소에 넣지 않는다). 프로토타입의 해당 시나리오 화면과 나란히 놓고 사람이 본다. 자동 픽셀 비교는 하지 않는다 — 레이아웃이 다르므로 의미가 없다.
3. **HTML 출력**: `public/html-lib/theme.css`를 쓰는 출력물 하나를 열어 배경·글자·링크 색이 앱과 같은지 본다.
4. **실기**: `npm run electron:dev`로 라이트·다크를 설정에서 바꿔 가며 선페인트 깜빡임(FOUC)이 없는지 본다. `boot.js`는 안 건드리지만 토큰 이름이 바뀐 곳이 있으면 깜빡임이 생길 수 있다.
5. **릴리스**: 릴리스 노트 en·ko 항목을 쓰고 `npm run release:check-notes`를 통과한다. GitHub 아티팩트에서 라이트·다크 한 번씩 연다.

## 7. 작업 순서 (MAC-M0)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| MAC-M0.1 | §3.1~3.3 토큰 교체(`globals.css` `:root`·`.dark`·`@theme`) | 앱이 보라 팔레트로 뜨고 typecheck 기준선 유지 |
| MAC-M0.2 | §4 상태색 이관 | grep 상태색 계열 0건, 테스트 통과 |
| MAC-M0.3 | §5 표면 8개 | 스크린샷 6×2 촬영, 프로토타입과 나란히 검토 |
| MAC-M0.4 | §3.4 글꼴, `html-lib/theme.css` 동기화 | 한글 화면 비교, HTML 출력 확인 |
| MAC-M0.5 | 릴리스 노트·태그·아티팩트 확인 | 공개 |

MAC-M0.1과 MAC-M0.2는 한 커밋이어도 된다. MAC-M0.3은 참가자 UI(MAC-M3)와 같은 파일을 만지므로 **MAC-M3 전에 끝내고 머지**한다.

## 8. 거절한 대안

- **컴포넌트마다 색을 고치기**: 2,140곳이 이미 토큰이다. 토큰을 놔두고 컴포넌트를 돌면 두 번 일한다.
- **새 테마 변형(`violet`)을 셋째 테마로 추가**: 라이트·다크 둘 다 새 팔레트가 기본이어야 한다. 옛 teal을 선택지로 남길 이유가 없다.
- **픽셀 비교 자동화**: 프로토타입과 셸은 레이아웃이 다르다. 사람이 나란히 보는 쪽이 싸고 정확하다.
- **글꼴 교체(Inter 제거)**: 프로토타입의 라틴 글자도 시스템 글꼴이라 차이가 작고, `next/font` 경로를 건드리면 로딩 깜빡임 위험이 생긴다(D14).

## 9. 구현 상태 (MAC-M0.1~M0.4, 2026-10-16)

Opus 에이전트가 구현했고 Fable 5.1이 스크린샷으로 확인했다. 커밋 전이다.

- ✅ **토큰**: violet 12단계(라이트·다크), §3.2 의미 토큰 전부, 신설 토큰, `--radius: 0.75rem`, 그림자 2종, `.bg-brand-gradient`. `MarkdownRenderer`의 인라인 코드·표 머리글은 `bg-accent`가 보라가 되어 `bg-code-surface`·`bg-muted`로 옮겼다. 브라우저 `theme-color`도 새 배경에 맞췄다.
- ✅ **상태색 이관**: 약 50개 파일. grep(red·amber·emerald·green·violet·blue·orange) 0건. 식별색은 `info`(sky, 문서 탭)·`brand`(violet)·muted(slate)로. `bg-primary`는 두 곳뿐이라 중립 버튼 이동은 없었다.
- ✅ **표면 8개**: 사용자 말풍선 `bg-user-bubble`, 나비 평문, 헤더 보조 줄 + 명단·토글 자리, 작성기 카드 + 그라데이션 원형 보내기 버튼(새 클릭 대상, Enter 경로 재사용), 승인 카드, 사이드바 `bg-sidebar` + 라벨(i18n `workspace.sidebarProjects/Sessions`), 설정 모달 `shadow-float` + nav 선택 `bg-accent text-brand-foreground`, 토스트. `AGENT_BUBBLE_CARD_CLASS`를 내보내 두었고 MAC-M3에서 쓴다.
- ✅ **글꼴·HTML**: `system` 스택에 Pretendard 삽입. `html-lib/theme.css`는 라이트·다크 블록에 모든 토큰을 다시 선언.
- ✅ **검증**: 타입체크 기준선 유지(셸 12·루트 30, 같은 줄). 셸 테스트 223 파일 / 4264 통과(스타일 단언 테스트 11개 갱신). prod 빌드 통과. `shell/scripts/ui-screenshots.mjs`(`--base --out --themes`)로 라이트·다크 9장씩 촬영(임시 HOME·DB, 텔레그램 꺼짐, 서버는 PID로 종료). 메시지 쌍은 프로바이더 키가 없어 임시 DB에 직접 심었다.
- ⏳ **MAC-M0.5 릴리스**: 아직. 커밋·릴리스 노트는 사용자 지시 때.

**구현 결정.** (1) success·warning의 다크 `-foreground`는 흰색이 아니라 페이지 배경색(`232 15% 11%`)이다 — 밝은 채움 위에 흰 글자는 대비가 낮다. (2) hex 리터럴 중 데이터(언어 색 93·모델/차트 27·git 레인 8·JSON 구문 6·`global-error.tsx`)는 남겼다. (3) Electron 창 배경 `#111111`(`electron/boot.ts`, naby 저장소)은 범위 밖이라 두었다 — 다크 배경 `#17181F`와 살짝 다르므로 MAC-M3 때 같이 맞춘다. (4) `bg-accent`가 약 140곳의 hover 색이기도 해서 hover가 전체적으로 옅은 보라다. §3.2대로이고 프로토타입의 선택 행과 같은 색이지만, 실기에서 과하면 hover용 토큰(`--muted`)으로 되돌릴 수 있다.

**프로토타입과 남은 차이.** 보내기·승인 외의 기본 버튼은 그라데이션이 아니라 평면이다. 헤더 명단은 MAC-M3까지 비어 있다. 탭 작업 공간에서는 `ChatHeader`가 숨겨져 엔진 줄이 헤더 역할을 한다.

## 변경 이력

- 0.2.1 (2026-10-16) — 사용자 피드백(1.44.0 실기): 나비 말풍선을 카드로 되돌리고 나비 아바타(`NabyAvatar`)를 둔다. §5 개정.
- 0.2.0 (2026-10-16) — §9 구현 상태(MAC-M0.1~M0.4 완료, 검증 결과, 구현 결정 4건, 남은 차이).
- 0.1.1 (2026-10-16) — spec-guard·교정 반영: violet은 9~11만 있어 12단계를 새로 정의(§3.1, 순서 명시), `bg-primary` 중립 버튼 점검, 마일스톤 접두어 `MAC-`, status review.
- 0.1.0 (2026-10-16) — 초안. multi-agent-chat 0.1.3 R7·D14·D15의 설계. 토큰 표(HSL), 신설 토큰 6개와 `-foreground` 짝·그림자 2개, 상태색 이관 규칙, 표면 8개, 검증 5항목, MAC-M0 작업 순서.
