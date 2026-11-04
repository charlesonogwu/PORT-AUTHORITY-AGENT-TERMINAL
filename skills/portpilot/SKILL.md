---
name: portpilot
description: Complete a requested browser task through PortPilot MCP. Use when the user invokes $portpilot or /portpilot, selects PortPilot from the skill menu, or explicitly asks to use PortPilot for browsing. This is browser automation, not work on PortPilot's source code.
---

<!-- managed-by-portpilot:portpilot-skill-v1 -->

# PortPilot browser task

Carry out the supplied browser task in the current conversation using the connected PortPilot MCP tools. The server may be named `portpilot` or `port-authority-agent-terminal`; identify it by its tools. If it is unavailable, explain that PortPilot must be connected and stop instead of substituting another browser, web search, direct CDP client, or browser launcher.

If the invocation contains no task, ask what the user wants PortPilot to do.

## Task identity

Use the absolute native project path as `cwd`, your integration's owner name, and one `sessionId` for this whole task, so this task gets its own browser and every call reuses it. Make the sessionId from lowercase letters, digits and hyphens, at most 40 characters, starting with something stable for the task, for example `t3-` plus the first 8 characters of the thread ID plus a short topic (`t3-9f3a1c2b-ebay-search`). Write it down and pass exactly the same value on every call. A different task gets a different sessionId; never use `default` or another task's sessionId. Keep the returned immutable `laneId` and use it for subsequent operations.

PortPilot's general tool descriptions warn that every extra sessionId starts another browser. That is about extra browsers within one task: inside this task, keep using this one sessionId and open more pages with `page_newtab`.

Owners include `codex`, `claude`, `cursor`, `opencode`, and `gemini`; use `agent` for Grok, with a stable `grok-` session prefix. Do not put task suffixes in `owner`.

## Saved login or new browser

For an explicitly requested saved website login, call `find_saved_login` with the exact workspace and website first. With one match, open its exact immutable `laneId`. With zero matches, report that no saved login was found; with several, ask which account to use. Do not create a replacement profile for a saved login. Call `remember_login` only after the user explicitly confirms that the login worked.

Otherwise call `open` with this task's owner, cwd, sessionId, and requested URL. Omit `browser` unless the user chose one. Use visible mode when the user needs to interact, and background/headless mode when appropriate for the task. Never use a personal browser profile.

If `open` reports that the browser was already running, its `url` and `mode` were not applied: navigate with `page_goto` instead.

## Complete and verify

Use PortPilot's `page_tabs`, `page_goto`, `page_newtab`, `page_text`, `page_eval`, `page_click`, `page_fill`, and `page_screenshot` as needed. Prefer new tabs inside this task's browser to extra browser processes. Page tools act on the first tab unless you pass `tab` (an id or index from `page_tabs` or `page_newtab`), so pass `tab` on every page call once the browser has more than one tab; saved-login browsers are shared and may already have other tabs. Verify navigation and actions from returned page state before reporting success.

Keep browser scope and permissions within the user's request. Invoking this skill does not authorize unrelated external actions or create a new agent thread.

## Finish

`release_lane` only clears bookkeeping; it never closes the browser, and after it PortPilot can no longer find that browser to close it. To close a browser, call `close_browser` with its `laneId` first, and only when the user asked or when it is a temporary browser you created for this task. Leave saved-login browsers the user expects to revisit open.
