export const HELP = `portpilot — local lane coordinator for AI coding agents

USAGE:
  portpilot <command> [options]

COMMANDS:
  list                          List all lanes
  status                        Show lanes + live port observations + warnings
  reserve --owner <n> --cwd <p> Reserve a lane (allocates app & Chrome ports + profile dir)
                  [--session <id>]   parallel session id (different sessions = different ports)
                  [--task "..."] [--app-range 3000-3099] [--chrome-range 9322-9399]
                  [--no-app-port] [--no-chrome-port] [--browser-script <path>]
                  [--browser chrome|edge|firefox] [--json]
  check --owner <n> --cwd <p>   Verify the lane is safe to use right now (Chrome attach safety)
                  [--session <id>] [--json]
  release --owner <n> --cwd <p> Mark a lane as released
                  [--session <id>] [--remove] (delete the entry instead of marking)
  next [--range 9322-9399]      Find the next free port in a range
                  [--json]
  doctor                        Audit registry vs. live ports, suggest cleanups
                  [--json]
  prune                         Garbage-collect released lanes from the registry
                  [--all]                    remove every released lane regardless of age
                  [--older-than 24h]         only remove released lanes older than this (default 24h)
                  [--dry-run]                preview without writing
  profiles <subcommand>         Manage the per-lane Chrome profile folders on disk (~/.portpilot/profiles)
                  list                       (default) every profile: size, owning lane, status, age
                  prune                      delete abandoned profiles to reclaim disk (and their saved logins)
                       (preview only unless --yes; NEVER touches active/reserved lanes)
                       [--yes]                    actually delete (default is a dry-run preview)
                       [--orphaned] [--released] [--stale]   pick buckets (default: orphaned + released)
                       [--all]                    every profile except active/reserved
                       [--older-than 30d]         only those whose lane was last seen before this
                       [--name <glob>]            target specific profiles (e.g. "scraper-*")
                  forget --profile-dir <path>   erase ONE lane's saved data (delete profile + drop lane)
                       [--lane <id>]              also remove this registry entry
                       (Chrome must already be closed; this is what the dashboard Erase button calls)
                  [--json]
  launch-chrome --owner <n> --cwd <p>
                                Launch Chrome bound to the lane's debug port + profile
                  [--session <id>] [--dry-run] [--bin <path>]
                  [--mode visible|background|headless]
                       visible    (default) normal window on the active desktop
                       background  real headed Chrome rendered off-screen; never
                                   steals focus — ideal for non-interactive CDP
                       headless    no window at all (--headless=new); some sites block it
                       (override globally via PORTPILOT_CHROME_MODE env or the
                        chromeMode field in ~/.portpilot/config.json)
  open --owner <n> --cwd <p>    Reserve + launch + navigate in ONE step, for Chrome, Edge, or Firefox
                  [--session <id>] [--task "..."] [--url <url>]
                  [--browser chrome|edge|firefox]   omit = existing lane's browser,
                       else the configured defaultBrowser (dashboard picker), else chrome
                  [--mode visible|background|headless]   firefox has no 'background'
                  [--dry-run] [--bin <path>] [--json]
                       Every browser gets a DEDICATED PortPilot profile — never your
                       personal browser profile.
                       Edge notes: Microsoft Edge is Chromium, so the debug port is
                       real Chrome CDP and all three modes work (like Chrome).
                       Override binary with PORTPILOT_EDGE_BIN.
                       Firefox notes: launches with -no-remote; the debug port is
                       WebDriver BiDi (ws://127.0.0.1:<port>/session), NOT Chrome CDP.
                       Drive it with 'portpilot page ...' (below) — same commands as
                       chrome/edge; PortPilot speaks BiDi for you. (The dashboard
                       still can't enumerate Firefox tabs.)
  page <sub> --owner <n> --cwd <p>
                                Drive the lane's browser — chrome/edge via CDP, firefox
                                via WebDriver BiDi. SAME subcommands for every backend.
                                Only ever controls the lane's OWN browser (safe-attach).
                  [--session <id>] [--tab <id|index|substring>] [--json]
                       --tab accepts a tab id, 0-based index, or url/title substring.
                       (Firefox tab ids change between calls — use index/substring.)
                  tabs                        list open tabs (id, url, title)
                  newtab [--url <url>]        open a NEW TAB in the lane's existing browser —
                                              the RAM-friendly way to get more pages (~100-200 MB/tab
                                              vs ~0.5-1.5 GB for every extra lane/session)
                  goto --url <url>            navigate + wait for load, returns url+title
                  eval --expr <js>            evaluate a JS expression, returns its JSON value
                  text [--selector <css>]     visible text of page/element (capped 20k chars)
                  click --selector <css>      click the first matching element
                  fill --selector <css> --value <text>   set a form field + fire input/change
                  screenshot [--out <file.png>]          save a PNG (default ~/.portpilot/shots)
  config <subcommand>           Manage ~/.portpilot/config.json
                  show                       (default) print current config
                  recommend                  show RAM-based recommendation
                  init [--force]             write recommended config (preserves existing values)
                  set <key> <value>          set maxActiveLanes / warnAtActiveLanes / chromeDebugRange / appPortRange
                                             / defaultBrowser (chrome|edge|firefox — used for NEW lanes when
                                             the caller doesn't pass --browser; also settable from the dashboard)
                  path                       print the config file path
  dashboard                     Open the native PortPilot dashboard app, showing every lane,
                                its current page, browser, and live status. No web server or
                                port is involved — it is a desktop app, not a localhost URL.
                                (The legacy --port / --host / --allow-remote / --no-open flags
                                are accepted but ignored, kept only so old shortcuts don't break.)
  shortcut <subcommand>         Manage the Windows desktop shortcut for the dashboard
                  install [--icon "<dll>,<index>"]                 create / refresh shortcut
                  uninstall                                         remove the shortcut
                  status                                            show install state
  autostart <subcommand>        Auto-start the dashboard at Windows login
                  install                                          add a shortcut to the Windows Startup folder
                  uninstall                                        remove the autostart entry
                  status                                           show whether autostart is enabled
  install-mcp <client>          Wire PAAT into an AI agent's MCP config (no manual JSON edit)
                  claude                                           Claude Desktop  → %APPDATA%\\Claude\\claude_desktop_config.json
                  claude-code                                      Claude Code CLI + Desktop Code tab → ~/.claude.json
                                                                   (uses \`claude mcp add\` when the CLI is available)
                  codex                                            Codex Desktop   → ~\\.codex\\config.toml
                  all (default)                                    all three — same as 'install-mcp' with no args
                  (JSON configs get timestamped backups; CLI-managed entries can be removed with \`claude mcp remove\`)
  install-skill <client>        Add the task-scoped /portpilot command to Codex and Claude Code
                  codex                                            Codex skill → ~/.codex/skills/portpilot
                  claude                                           Claude Code (CLI and Desktop Code tab) → ~/.claude/skills/portpilot
                  all (default)                                    install both integrations
                  The command uses only PortPilot MCP for that task and never
                  falls back to another browser tool. Existing unmanaged skills
                  named portpilot are left unchanged.
  mcp                           Run the MCP server over stdio
  help                          Show this help

GLOBAL FLAGS:
  --json                        Emit machine-readable JSON
  --owner <name>                Agent owner: codex, claude, gemini, ...
  --cwd <path>                  Project working directory
  -h, --help                    Show help

EXAMPLES:
  portpilot reserve --owner codex --cwd C:\\Users\\me\\Downloads\\vend-site --task "ship checkout"
  portpilot check  --owner codex --cwd C:\\Users\\me\\Downloads\\vend-site
  portpilot open   --owner codex --cwd C:\\Users\\me\\Downloads\\vend-site --browser firefox --url about:blank
  portpilot open   --owner codex --cwd C:\\Users\\me\\Downloads\\vend-site --browser edge --mode background
  portpilot list --json
  portpilot doctor

Storage: %HOME%/.portpilot/lanes.json (override with PORTPILOT_HOME).
`;
