#!/usr/bin/env node
// Fixture stand-in for scripts/deps-check.js — naby replaces it (§3.6) and must NEVER
// run it. If it ever runs, it leaves a marker the hooks spike looks for.
"use strict";
const fs = require("fs");
if (process.env.NABY_SPIKE_HOOK_LOG) fs.appendFileSync(process.env.NABY_SPIKE_HOOK_LOG, JSON.stringify({ script: "deps-check.js", forbidden: true }) + "\n");
