#!/usr/bin/env node
// Fixture stand-in for scripts/run-skill-hook.js. Records how it was called and
// answers as `NABY_SPIKE_HOOK_CONTROL` says (keyed by the hook file, e.g.
// `pre-commit.py`, optionally `:<event>`). Inert without NABY_SPIKE_HOOK_LOG.
"use strict";
require("./_record.js")("run-skill-hook.js", process.argv[3] || "");
