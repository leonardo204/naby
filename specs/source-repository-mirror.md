---
id: source-repository-mirror
title: 소스 저장소 정본과 GitHub 미러 규약
type: interface
version: 1.0.0
status: active
scope: 소스 정본을 어느 저장소에 두는지, GitHub 미러를 어떻게 맞추는지, 릴리스와 자동 업데이트가 어디서 일어나는지를 정한다. 릴리스 검증 절차 자체는 packaging-path-resolution이 다룬다.
related: [packaging-path-resolution, phase-1-shell-architecture]
updated: 2026-10-07
---

# 소스 저장소 정본과 GitHub 미러 규약

2026-10-07부터 소스 정본은 사내 Bitbucket Cloud에 둔다. GitHub는 미러로 남고, 빌드와 릴리스와 자동 업데이트는 전과 같이 GitHub에서 일어난다. 바뀐 것은 저장소 위치와 push 경로뿐이고, 빌드 설정은 손대지 않았다.

## 1. 저장소

| 역할 | naby (본체) | cockpit (`shell/` submodule) |
|---|---|---|
| **정본** | `git@bitbucket.org:altimedia/ass-naby.git` | `git@bitbucket.org:altimedia/ass-cockpit.git` |
| 미러 (빌드·릴리스) | `git@github.com:leonardo204/naby.git` | `git@github.com:leonardo204/cockpit.git` |
| upstream | 없음 | `https://github.com/Surething-io/cockpit.git` (받기만 한다) |

## 2. 릴리스는 바꾸지 않는다

- `v*.*.*` 태그가 GitHub에 올라가면 `.github/workflows/release.yml`이 mac·win·linux를 빌드하고 서명해 GitHub Release에 올린다.
- 설치된 앱은 `electron-builder.yml`의 `publish: provider: github`(leonardo204/naby)를 보고 업데이트한다. 이 주소를 바꾸면 이미 설치된 앱의 업데이트가 끊긴다.
- 릴리스 검증 순서(draft로 올리고, GitHub에서 받은 아티팩트로 확인한 뒤 공개)는 [패키징 경로 해석](packaging-path-resolution.md) §4를 그대로 따른다.
- Bitbucket Pipelines는 쓰지 않는다. Bitbucket Cloud에는 macOS 빌드 머신이 기본으로 없어서 서명과 공증을 옮길 수 없다.

## 3. 로컬 원격 설정

naby와 `shell/` 모두 같은 모양으로 둔다.

- `origin`은 Bitbucket에서 받는다. push 주소는 **Bitbucket과 GitHub 두 개**다. `git push origin …` 한 번으로 양쪽이 같이 맞춰진다.
- `github` 원격을 따로 둔다. GitHub만 따로 확인할 때 쓴다.

새 기기에서 clone하면 아래처럼 맞춘다. `shell/`에서는 저장소 이름을 `ass-cockpit`·`cockpit`으로 바꿔 같은 명령을 실행한다.

```sh
git remote set-url origin git@bitbucket.org:altimedia/ass-naby.git
git remote set-url --add --push origin git@bitbucket.org:altimedia/ass-naby.git
git remote set-url --add --push origin git@github.com:leonardo204/naby.git
git remote add github git@github.com:leonardo204/naby.git
```

## 4. push 규칙

- **push는 항상 `origin`으로 한다.** 한쪽에만 올리지 않는다. 릴리스 태그도 `git push origin vX.Y.Z`로 올린다. GitHub에 태그가 올라가는 순간 릴리스 빌드가 시작된다.
- 순서는 전과 같다. `shell/`을 먼저 push하고, 셸 포인터를 옮긴 naby를 push한다. 반대로 하면 그 사이에 clone하거나 릴리스 빌드가 돌 때 아직 올라가지 않은 셸 커밋을 받지 못한다.
- **Bitbucket 웹에서 merge한 커밋은 GitHub에 자동으로 가지 않는다.** Bitbucket Cloud에는 다른 저장소로 push 미러링하는 기능이 없다. 웹에서 merge했으면 로컬에서 `git pull` 후 `git push origin`으로 GitHub를 맞춘다.
- 두 저장소의 브랜치와 태그가 어긋나면 Bitbucket 쪽을 기준으로 GitHub를 맞춘다.

## 5. submodule 주소는 GitHub로 둔다

`.gitmodules`의 `shell` 주소는 `git@github.com:leonardo204/cockpit.git` 그대로 둔다. GitHub Actions가 별도 인증 없이 submodule을 받아야 하기 때문이다. Bitbucket에서 clone해도 submodule은 GitHub에서 받는다. GitHub cockpit이 공개 저장소인 동안에는 문제가 없다.

## 6. 전제

- GitHub의 naby와 cockpit은 **공개 저장소**다. 자동 업데이트가 인증 없이 Release를 받으려면 naby가 공개 상태여야 한다. 이 구성은 소스 비공개를 목표로 하지 않는다.
- 소스까지 비공개로 해야 한다면 이 규약으로는 안 된다. 소스와 Release를 다른 저장소로 나누고, 빌드를 로컬이나 다른 CI로 옮겨야 한다. 이 경우의 업데이트 경로(공개 버킷과 generic provider)는 phase-1-shell-architecture의 Update feed 판단을 따른다. 그때는 이 문서를 새 버전으로 고친다.
