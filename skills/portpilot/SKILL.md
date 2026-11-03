---
name: portpilot
description: Complete a requested browser task through PortPilot MCP. Use when the user invokes $portpilot or /portpilot, selects PortPilot from the skill menu, or explicitly asks to use PortPilot for browsing. This is browser automation, not work on PortPilot's source code.
---

<!-- managed-by-portpilot:portpilot-skill-v1 -->

# PortPilot browser task

Carry out the supplied browser task in the current conversation using the connected PortPilot MCP tools. The server may be named `portpilot` or `port-authority-agent-terminal`; identify it by its tools. If it is unavailable, explain that PortPilot must be connected and stop instead of substituting another browser, web search, direct CDP client, or browser launcher.

If the invocation contains no task, ask what the user wants PortPilot to do.

## Task identity

Use the absolute native project path as `cwd`, your integration's owner name, and one unique, stable `sessionId` for this task. Prefer a stable host thread/task ID; if it is long, hash the complete ID into a short identifier. Keep the returned immutable `laneId` and use it for subsequent operations. A different task gets a different session. Never copy an unrelated lane's session or use `default`.

Owners include `codex`, `claude`, `cursor`, `opencode`, and `gemini`; use `agent` for Grok, with a stable `grok-` session prefix. Do not put task suffixes in `owner`.

## Saved login or new browser

For an explicitly requested saved website login, call `find_saved_login` with the exact workspace and website first. With one match, open its exact immutable `laneId`. With zero matches, report that no saved login was found; with several, ask which account to use. Do not create a replacement profile for a saved login. Call `remember_login` only after the user explicitly confirms that the login worked.

Otherwise call `open` with this task's owner, cwd, sessionId, and requested URL. Omit `browser` unless the user chose one. Use visible mode when the user needs to interact, and background/headless mode when appropriate for the task. Never use a personal browser profile.

## Complete and verify

Use PortPilot's `page_tabs`, `page_goto`, `page_newtab`, `page_text`, `page_eval`, `page_click`, `page_fill`, and `page_screenshot` as needed. Prefer new tabs inside this task's browser to extra browser processes. Verify navigation and actions from returned page state before reporting success.

Keep browser scope and permissions within the user's request. Invoking this skill does not authorize unrelated external actions or create a new agent thread. `release_lane` only clears bookkeeping and does not close the browser. Close a browser only when requested or when cleaning up a temporary browser you created for verification, after rechecking its exact lane. Preserve saved-login browsers the user expects to revisit.
