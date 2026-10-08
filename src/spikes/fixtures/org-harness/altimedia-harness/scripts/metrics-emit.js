#!/usr/bin/env node
// ---- naby fixture prelude (NOT upstream) ----------------------------------
// Everything between these two marker lines is the fixture's own. Below the
// second marker is altimedia-harness 0.8.1 `scripts/metrics-emit.js` VERBATIM,
// minus its shebang line (the shebang above is the same one). spike-org-harness-
// metrics re-hashes "shebang + body" against the upstream sha256, so the stage
// rules, the 8-field payload, the agent_id / compact filters and the
// HARNESS_CLIENT handling under test are the real ones (org-harness-sync §3.7).
//
//   1. NABY_SPIKE_HOOK_LOG set (spike-org-harness-hooks): record the call and
//      answer as NABY_SPIKE_HOOK_CONTROL says, like every other stand-in script.
//   2. Neither HARNESS_METRICS_DRYRUN=1 nor HARNESS_METRICS_URL set: exit 0. A
//      fixture must never POST to the real Skill Hub, whatever token a spike or
//      a test happens to hand it.
if (process.env.NABY_SPIKE_HOOK_LOG) {
  require("./_record.js")("metrics-emit.js", "metrics");
  return;
}
if (process.env.HARNESS_METRICS_DRYRUN !== "1" && !process.env.HARNESS_METRICS_URL) {
  return;
}
// ---- end naby fixture prelude; upstream 0.8.1 follows verbatim ------------
/**
 * metrics-emit.js — 하네스 적용률 이벤트 전송 (훅 H1~H4)
 *
 * hooks.json 의 SessionStart / UserPromptSubmit / PostToolUse / Stop 에서
 * `type: "command", async: true` 로 실행된다. stdin 으로 받은 훅 입력을
 * Skill Hub 집계 API(POST /api/v1/harness/events) 형식으로 바꿔 보낸다.
 *
 * 원칙
 *   - 사용자 작업을 절대 막지 않는다. 어떤 경우에도 exit 0, stdout 에는 아무것도 쓰지 않는다.
 *   - 프롬프트 본문·파일 경로·명령어는 보내지 않는다. 보내는 필드는 아래 8개뿐이다.
 *   - 토큰이 없으면 조용히 건너뛴다(관리 설정이 아직 안 내려온 단말).
 *
 * 환경변수
 *   HARNESS_METRICS_TOKEN   관리 설정 env. 없으면 설치 때 activate.js 가 받아 둔 토큰(~/.cache/altimedia-harness/activation.json)을 쓴다.
 *   HARNESS_CLIENT          훅을 띄운 도구. claude-code(기본) | naby. naby 는 훅을 띄울 때 HARNESS_CLIENT=naby 를 넣는다.
 *   HARNESS_TEAM            팀코드(kebab-case). 팀 저장소 .claude/settings.json 의 env 로 둔다. 없으면 "unassigned".
 *   HARNESS_METRICS_URL     기본 https://skills.altimedia.com/api/v1/harness/events (검증용 덮어쓰기)
 *   HARNESS_METRICS_DISABLED=1  전송 끄기
 *   HARNESS_METRICS_DRYRUN=1    전송하지 않고 페이로드를 stderr 로 출력
 *
 * 요구: Node.js 18 이상 (전역 fetch). 의존 패키지 없음.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_URL = "https://skills.altimedia.com/api/v1/harness/events";
const TIMEOUT_MS = 5000;

/**
 * 업무 5단계 매핑 — 이벤트 → 단계. 설계서 11장 기준.
 * Confluence 쓰기 도구는 두 가지 이름을 잡는다.
 *   - mcp-atlassian:            mcp__<서버>__confluence_create_page · confluence_update_page
 *   - Atlassian 공식 OAuth MCP: mcp__<서버>__createConfluencePage · updateConfluencePage
 *     (플러그인: mcp__plugin_altimedia-harness_atlassian__createConfluencePage, naby: mcp__atlassian__createConfluencePage)
 * hooks/hooks.json 의 PostToolUse matcher 와 같은 규칙이어야 한다.
 */
const CONFLUENCE_WRITE_RE = /^mcp__.*__(confluence_(create|update)_page|(create|update)ConfluencePage)$/;
function stageOf(input) {
  switch (input.hook_event_name) {
    case "SessionStart":
      return "입력";
    case "UserPromptSubmit":
      return "맥락";
    case "PostToolUse":
      return CONFLUENCE_WRITE_RE.test(String(input.tool_name || "")) ? "기록" : "실행";
    case "Stop":
      return "검수";
    default:
      return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function harnessVersion() {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
    path.join(__dirname, "..", ".claude-plugin", "plugin.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch {
      /* 다음 후보 */
    }
  }
  return "0.0.0";
}

/** 저장소 식별자 — origin 리모트에서 owner/name 만 뽑는다. git 이 없거나 저장소가 아니면 폴더 이름. */
function repoOf(cwd) {
  if (!cwd) return null;
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
    if (m) return m[1];
  } catch {
    /* 리모트 없음 */
  }
  return path.basename(cwd) || null;
}

/** 훅을 띄운 도구. 허용 값이 아니거나 비어 있으면 claude-code. activate.js 와 같은 규칙이다. */
const CLIENTS = ["claude-code", "naby"];
function clientOf() {
  const raw = (process.env.HARNESS_CLIENT || "").trim().toLowerCase();
  return CLIENTS.includes(raw) ? raw : "claude-code";
}

function teamOf() {
  const raw = (process.env.HARNESS_TEAM || "").trim().toLowerCase();
  return /^[a-z0-9](-?[a-z0-9])*$/.test(raw) && raw.length <= 64 ? raw : "unassigned";
}

/** 설치 때 activate.js 가 API 키로 받아 둔 집계 토큰. 관리 설정 env 가 있으면 그쪽이 우선이다. */
function activatedToken() {
  try {
    const f = path.join(require("os").homedir(), ".cache", "altimedia-harness", "activation.json");
    return String(JSON.parse(fs.readFileSync(f, "utf8")).token || "");
  } catch {
    return "";
  }
}

async function main() {
  if (process.env.HARNESS_METRICS_DISABLED === "1") return;
  const token = (process.env.HARNESS_METRICS_TOKEN || activatedToken()).trim();
  const dryRun = process.env.HARNESS_METRICS_DRYRUN === "1";
  if (!token && !dryRun) return;

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!input || typeof input !== "object") return;

  // 서브에이전트 안에서 발생한 이벤트는 세지 않는다 (메인 스레드 기준 집계).
  if (input.agent_id) return;
  // 컴팩션 뒤 다시 뜨는 SessionStart 는 새 세션이 아니다.
  if (input.hook_event_name === "SessionStart" && input.source === "compact") return;

  const stage = stageOf(input);
  if (!stage) return;

  const payload = {
    session_id: String(input.session_id || "").slice(0, 128),
    team: teamOf(),
    repo: repoOf(input.cwd),
    event: input.hook_event_name,
    stage,
    harness_version: harnessVersion(),
    client: clientOf(),
    ts: new Date().toISOString(),
  };
  if (!payload.session_id) return;

  if (dryRun) {
    process.stderr.write(JSON.stringify(payload) + "\n");
    return;
  }
  if (typeof fetch !== "function") return;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    await fetch(process.env.HARNESS_METRICS_URL || DEFAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch {
    /* 사내망 밖·서버 점검 등. 재시도하지 않는다. */
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
