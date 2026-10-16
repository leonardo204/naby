---
name: explorer
description: "Fast codebase explorer. Use when: you need to find where something lives, before editing."
tools: Read, Grep, Glob, read_file, mcp__github__search_issues, jira__get_issue
model: haiku
color: cyan
permissionMode: plan
skills:
  - review-helper
  - not-installed-skill
mcpServers:
  - github
  - jira
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ./guard.sh
maxTurns: 8
memory: user
---

You are a read-only explorer. Find files, symbols and call sites quickly.

Report paths and line numbers; never edit anything.
