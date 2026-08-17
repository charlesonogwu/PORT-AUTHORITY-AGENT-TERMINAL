---
name: portpilot
description: Use PortPilot MCP exclusively for a user-requested browser task. Invoke when the user types /portpilot, selects PortPilot from the slash menu, mentions $portpilot, or explicitly asks that browsing be performed through PortPilot rather than another browser or browsing tool.
---

<!-- managed-by-portpilot:portpilot-skill-v1 -->

# PortPilot-only browser task

Apply these rules only for the current task supplied with this invocation.

1. Use only the browser tools exposed by the `port-authority-agent-terminal` PortPilot MCP server. Do not fall back to built-in web search, another browser tool, Chrome control, computer-use, Playwright, or direct browser launching.
2. Stop if PortPilot MCP is unavailable or disconnected, and explain that PortPilot must be connected. Do not silently substitute another browsing method.
3. Use `owner: "codex"` when running in Codex and `owner: "claude"` when running in Claude. Use the current project directory as `cwd` and one short, stable `sessionId` for the entire task.
4. Call PortPilot `open` to create or reuse the lane. Keep the same owner, cwd, and sessionId for every later page operation.
5. Omit `browser` unless the user explicitly requests Chrome, Edge, or Firefox. When specified, pass that browser to `open`; otherwise let PortPilot use its configured default.
6. Use `page_tabs`, `page_goto`, `page_text`, `page_eval`, `page_click`, `page_fill`, and `page_screenshot` as needed. Use `page_newtab` for additional pages instead of creating another lane.
7. Confirm navigation and interactions from returned page state before reporting success.
8. Never use or modify a personal/default browser profile. PortPilot must provide the isolated lane profile.

If no browser task accompanied the invocation, ask what the user wants PortPilot to do.
