// Fixture-only helper shared by the stand-in hook scripts (org-harness-sync §3.5,
// spike-org-harness-hooks). With NABY_SPIKE_HOOK_LOG unset — every spike but the
// hooks one, and the app — it does nothing and the script exits 0, like the real
// scripts do when they have nothing to say.
"use strict";
const fs = require("fs");

const ENV_KEYS = [
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PROJECT_DIR",
  "HARNESS_CLIENT",
  "CLAUDE_PLUGIN_OPTION_CIC_TOKEN",
  "CIC_API_TOKEN",
  "HARNESS_METRICS_TOKEN",
  "HARNESS_METRICS_DISABLED",
  "ELECTRON_RUN_AS_NODE",
  "CLAUDE_PLUGIN_OPTION_SHUB_API_KEY",
  "SHUB_API_KEY",
];

module.exports = function record(script, controlKey) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  const log = process.env.NABY_SPIKE_HOOK_LOG;
  if (!log) return;
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    input = raw;
  }
  const env = {};
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  fs.appendFileSync(
    log,
    JSON.stringify({ script, args: process.argv.slice(2), input, env, cwd: process.cwd(), at: Date.now() }) + "\n",
  );
  let control = {};
  try {
    control = JSON.parse(fs.readFileSync(process.env.NABY_SPIKE_HOOK_CONTROL || "", "utf8"));
  } catch {
    control = {};
  }
  const event = input && typeof input === "object" ? input.hook_event_name : "";
  const c = control[`${controlKey}:${event}`] || control[controlKey] || {};
  const finish = () => {
    if (c.stdout !== undefined) process.stdout.write(typeof c.stdout === "string" ? c.stdout : JSON.stringify(c.stdout));
    if (c.crash) throw new Error("stand-in hook crashed on purpose");
    process.exitCode = c.exit || 0;
  };
  if (c.sleepMs) {
    // Keep the process alive for the sleep.
    setTimeout(finish, c.sleepMs);
  } else {
    finish();
  }
};
