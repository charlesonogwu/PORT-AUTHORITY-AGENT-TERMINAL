# macOS runtime validation

Use temporary state only; PortPilot must never use a normal browser profile.

```bash
export PORTPILOT_HOME="$(mktemp -d)/portpilot"
paat open --owner mac-test --cwd "$PWD" --session chrome --browser chrome --mode headless --url about:blank --json
paat check --owner mac-test --cwd "$PWD" --session chrome --json
paat open --owner mac-test --cwd "$PWD" --session firefox --browser firefox --mode headless --url about:blank --json
paat check --owner mac-test --cwd "$PWD" --session firefox --json
```

Firefox may need a few seconds to open its BiDi listener. Repeat `paat check`
until it reports `safe-attach`; `safe-free` immediately after launch means the
browser has not begun listening yet. Inspect the matching process with
`ps -ww -p <pid> -o pid= -o command=`: Chrome must include a profile under
`$PORTPILOT_HOME/profiles`; Firefox must include that profile and `-no-remote`.
Release the temporary lanes, stop their browsers, and remove only the temporary
directory created by `mktemp`.
