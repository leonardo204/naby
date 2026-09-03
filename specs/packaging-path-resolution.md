---
id: packaging-path-resolution
title: 패키징 경로 해석과 릴리스 검증 규약
type: interface
version: 1.2.0
status: active
scope: 배포본에서 런타임이 파일과 패키지를 어떻게 찾는지, 그리고 릴리스가 실제로 동작하는지 무엇으로 확인하는지를 정한다. `import.meta.url`이 번들러에 따라 빌드 머신 경로로 굳는 문제와, 그 때문에 로컬 패키징 검증이 무효가 되는 문제를 다룬다. 개발 프로바이더 봉인이 배포 경계에서 어떻게 열리는지도 함께 둔다(키 게이트는 1.2.0에서 제거). 엔진 선택 규칙 자체는 phase-2-2.5-plan이 다룬다.
related: [phase-1-desktop-shell, chatgpt-oauth-dev-provider, phase-1-contracts, personalized-agent-desktop-app]
updated: 2026-09-03
---

# 패키징 경로 해석과 릴리스 검증 규약

v1.4.0부터 v1.5.3까지 릴리스 다섯 번이 같은 뿌리에서 나왔다. **번들러마다 다르게 취급하는 경로 기준점**, 그리고 그걸 드러내지 못하는 검증 방식이었다. 이 문서는 둘을 규약으로 고정한다.

---

## 1. 런타임 코드는 세 번 번들된다

`src/`의 한 모듈이 배포본에 **세 벌** 들어간다. 셋의 성질이 다르다.

| 사본 | 만드는 도구 | `import.meta.url` |
|------|------------|-------------------|
| `dist/naby-runtime.mjs` | esbuild | 보존한다 |
| `shell/dist/chunk-*.mjs` | esbuild (`build:server`) | 보존한다 |
| `shell/.next-prod/server/chunks/*.js` | **Next(webpack)** | **빌드 머신 절대 경로로 굳힌다** |

`/api/naby`를 처리하는 것은 세 번째 사본이다. CI가 만든 아티팩트에는 이런 값이 박혀 있다.

```
file:///Users/runner/work/naby/naby/dist/naby-runtime.mjs
```

사용자 기계에 없는 디렉터리다. 여기서 파생한 경로는 전부 죽은 경로다.

## 2. 경로 기준점 규약

**런타임에서 경로를 해석할 때 `import.meta.url`을 1순위로 쓰지 않는다.** 아래 순서를 지킨다.

1. `process.env.NABY_APP_ROOT` — `electron/boot.ts`가 `app.getAppPath()`로부터 공표한다. Next 서버 기동 **전에** 설정하며, 같은 프로세스라 서버가 읽는다.
2. `process.env.COCKPIT_ROOT` — `electron/next-server.ts`가 셸 디렉터리로 설정한다.
3. `import.meta.url`에서 파생한 상위 디렉터리 — 소스 체크아웃, `tsx`, 스파이크, CLI가 여기에 해당한다.

순서를 지키는 이유는 적중률이 아니다. **배포본은 자기 사본을 써야 한다.** 같은 디스크에 굴러다니는 남의 체크아웃을 집으면 다른 버전이 물린다.

`process.cwd()`는 기준점으로 **쓰지 않는다.** 공짜 폴백처럼 보이지만 실행 디렉터리의 체크아웃으로 새는 통로다. 굳은 빌드 경로와 같은 종류의 함정이다.

### 읽기와 실행은 asar를 다르게 본다

**asar 안의 경로는 읽을 수는 있어도 실행할 수는 없다.** Electron이 `fs`를 패치해 `app.asar/...` 읽기를 언팩된 사본으로 넘겨주지만, `posix_spawn`과 `LoadLibraryW`는 OS의 것이라 패치가 닿지 않는다. OS에게 `app.asar`는 디렉터리가 아니라 파일이므로 그 경로로 프로세스를 띄우면 `spawn ENOTDIR`이 난다.

패키지 하나가 **하위 프로세스를 띄운다면** 그 패키지의 경로는 `app.asar.unpacked` 쪽으로 돌려야 한다. Agent SDK가 그렇다. 자기 모듈 위치를 기준으로 `claude` 엔진 바이너리를 찾기 때문에, 아카이브 경로에서 로드하면 바이너리 경로도 아카이브를 통과한다.

돌릴 때는 **언팩된 쌍둥이가 실제로 있는지 확인하고** 돌린다. `electron-builder.yml`이 경고하는 무작정 `.replace('app.asar', 'app.asar.unpacked')`와 이 점이 다르다. 언팩되지 않은 파일에는 쌍둥이가 없고, 그런 경로를 바꾸면 멀쩡히 읽히던 파일이 사라진다.

### 패키지를 찾을 때 한 가지 더

`electron-builder.yml`이 루트 `node_modules`를 통째로 제외한다(`'!node_modules/**'`). 그래서 배포본에서 npm 패키지는 **`shell/node_modules`로만** 들어온다. Node는 상위 디렉터리만 훑으므로 `app.asar/shell/node_modules`는 `app.asar/dist`에서 보이지 않는다. 기준점을 `<루트>/shell/package.json`으로 잡아야 `<루트>/shell/node_modules`가 첫 후보가 된다.

## 3. 술어는 하나만 둔다

"이 환경에서 dev 엔진이 돌 수 있는가"의 답은 `isClaudeAgentSdkAvailable` **하나**다.

`src/engines/claude-login.ts`가 같은 판정을 자체 구현으로 들고 있었다. 주석에는 "재구현이 아니라 재사용"이라고 적혀 있었지만 실제로는 재구현이었다. 엔진 쪽만 고쳐지자 계정 칩이 쓰는 `relevant`는 옛 답을 계속 냈고, **엔진은 동작하는데 계정 UI만 사라지는** 상태가 나왔다.

판정 함수를 새로 만들기 전에 같은 질문에 답하는 함수가 있는지 먼저 찾는다. 사본이 둘이면 답도 둘이고, UI는 그중 하나만 믿는다.

## 4. 릴리스 검증 규약

**로컬 패키징본으로 경로 문제를 검증할 수 없다.** 빌드 머신에서는 굳은 경로가 실재하므로 고장난 코드도 통과한다. v1.5.1은 이 방식으로 검증하고 공개했다가 실패했다.

릴리스는 이 순서를 지킨다.

1. `electron-builder.yml`의 `releaseType: draft`로 올린다.
2. **GitHub에서 아티팩트를 내려받는다.** 로컬 빌드 산출물이 아니다.
3. 받은 아티팩트로 확인한다.
   - `app.asar`를 풀어 대상 파일이 실제로 있는지 본다.
   - 앱 자신의 Electron 바이너리로 실행해 본다.
     `ELECTRON_RUN_AS_NODE=1 Naby.app/Contents/MacOS/Naby -e "..."`
   - 굳은 빌드 경로가 **이 기계에 없다는 것**을 함께 확인한다. 그래야 성공이 우연이 아님이 성립한다.
4. `gh release edit <tag> --draft=false --latest`로 공개한다.

`asar extract-file`은 0바이트를 내놓는 경우가 있다. 그것을 부재의 근거로 삼지 않는다. asar 바이너리를 직접 조회해 확인한다.

## 5. 개발 프로바이더는 기본으로 열려 있다

배포본에서 Claude·ChatGPT 구독 로그인을 막던 키 게이트(`electron/devmode.ts`, 설정의 "개발 모드")는 2026-09-03에 없앴다. 이 앱은 사내에서 혼자 쓰는 개발용 도구다. 지킬 최종 사용자가 없는데, 키를 가진 단 한 명이 설치할 때마다 키를 입력하는 절차만 남아 있었다.

- `electron/main.ts`가 실행할 때마다 `NABY_ENABLE_CHATGPT_OAUTH=1`을 기본값으로 넣는다. 패키징 여부는 보지 않는다. `boot()`이 봉인을 한 번만 읽으므로 그보다 먼저 실행한다.
- 환경변수를 `0`으로 명시하면 그대로 둔다. 끄는 방법은 이것뿐이다.
- 빌드 때 `FORCE_DEVMODE_KEY` 해시를 넣던 단계, CI 시크릿, `~/.naby/devmode-unlocked` 마커, `devmode:*` IPC 채널은 모두 없어졌다. 마커 파일이 남아 있어도 읽는 코드가 없다.

## 6. 스파이크

`npm run spike:sdk-resolve` (10)

`spike:sdk-resolve`는 임시 디렉터리에 **배포본 레이아웃을 재구성해서** 검사한다. 소스 체크아웃에서는 루트 `node_modules`가 항상 먼저 걸리므로 이 계열의 버그가 드러나지 않기 때문이다. 다음을 포함한다.

- `import.meta.url`이 죽은 레이아웃에서 `NABY_APP_ROOT`만으로 찾아내는가
- 앱 루트가 모듈 기준 경로를 **이기는가**
- 없는 것을 있다고 하지 않는가 (양방향)
- 칩의 `relevant`와 엔진의 가용성이 **양방향으로** 일치하는가
- asar 안에서 걸린 경로를 언팩된 쌍둥이로 돌리는가, 그리고 쌍둥이가 없으면 **건드리지 않는가**

마지막 항목은 하드코딩된 `true`로는 통과할 수 없다. 수정을 되돌리면 실패하는 것까지 확인하고 넣었다. 스파이크를 추가할 때는 **고치기 전 상태에서 실패하는지** 먼저 본다. 통과만 하는 검사는 검사가 아니다.
