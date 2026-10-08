#!/usr/bin/env node
// Fixture stand-in for scripts/metrics-emit.js (records only; never sends).
"use strict";
require("./_record.js")("metrics-emit.js", "metrics");
