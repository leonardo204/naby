---
name: task
description: 업무 1건을 여닫고 업무 5단계(입력·맥락·실행·검수·기록)를 잡는 스킬. 열린 업무가 없으면 아무것도 하지 않는다. TRIGGER — "/task start <유형 · 문서 종류(회의록 · 주간보고 …) | Jira 키 | URL | 제목>" "/task close" "/task promote <대상>", 또는 분명한 발화("회의록 작업 시작" "이 업무 닫자" "확인 받았어, 마무리"). 세션 시작 자동 진입 · 이슈 키 자동 감지는 하지 않는다.
---

# task (fixture)

Synthetic body for spike-org-harness-migrate. The real SKILL.md is much larger;
this one only needs to be a stable body that a same-name user copy can match or not.

Run `python3 ${CLAUDE_PLUGIN_ROOT}/skills/task/scripts/main.py` from the project root.
Since 0.8 the real skills call their scripts as `python3 "${CLAUDE_SKILL_DIR}/scripts/main.py" start`.
