# Contributing to Port Authority Agent Terminal (paat)

Thanks for taking a look. Bug reports, design feedback, and PRs are all welcome.
This document covers how to set up the repo and what we expect from a clean PR.

## Scope reminder

`paat` is **Windows-first**. The Mac/Linux fallback branches in
`src/core/scanner.ts` and `src/dashboard/kill.ts` are kept as best-effort but
are not part of CI. PRs that improve them are welcome; PRs that break Windows
to make Mac/Linux nicer will not merge.

## Local setup

You need:

- Windows 10 or 11
- Node.js 18.17 or newer
- Git
- Google Chrome (or Chromium / Edge / Brave) installed in a default path

```powershell
git clone https://github.com/charlesonogwu/port-authority-agent-terminal.git
cd port-authority-agent-terminal
npm install
npm --prefix dashboard-ui/portpilot-dashboard install
npm run build
npm link
```

After `npm link`, the binaries `paat`, `port-authority`, and `portpilot` are on
your PATH and point at this working tree.

## Development loop

| What you changed | What to run |
|---|---|
| Anything in `src/` | `npm run build:server` (just tsc, ~3s) |
| Anything in `dashboard-ui/portpilot-dashboard/src/` | `npm run build:dashboard` (Vite + tsc, ~10s) |
| Anything | `npm test` (full suite + lint, ~15s) |

For a fast inner loop on the dashboard UI:

```powershell
cd dashboard-ui/portpilot-dashboard
npm run dev   # Vite dev server with HMR; point at the live API on :7321
```

## Tests

The test suite runs entirely under `node --test` against compiled output in
`dist/tests`. Coverage today is around 130 tests; new features should land
with tests.

What we test for:

- **Pure unit tests** for `lane`, `paths`, `lockfile`, `registry`, `allocator`,
  `chrome`, `args`, `config`, `prune`, `canonicalize`, security validators.
- **Spawn-based CLI tests** that drive the real binary against a temp
  `PORTPILOT_HOME`.
- **Robust integration test** at `scripts/robust-test.ts` — spawns real
  Chrome processes, exercises every safety verdict, cleans up.

Run only the new file you're working on:

```powershell
npm run build:server
node --test --test-reporter=spec dist/tests/<your-file>.test.js
```

Run the full robust test (spawns Chrome — Windows only):

```powershell
npm run robust-test:verbose
```

## PR checklist

Before opening a PR:

- [ ] `npm test` passes locally (full suite, not just your new file).
- [ ] Test added for any new logic, including edge cases that already broke
      something for you while writing it.
- [ ] No new TypeScript errors (`npm run lint`).
- [ ] If you changed the dashboard React app, you ran `npm run build:dashboard`
      so the inlined HTML in `src/ui/dashboard.ts` is up to date and committed.
- [ ] If you touched MCP tool descriptions, you tested with a fresh Claude
      Desktop / Codex Desktop session (cached descriptions otherwise lie about
      the new behavior).
- [ ] No secrets, tokens, or absolute personal paths in the diff.

## Code style

- TypeScript everywhere. `tsc --noImplicitAny --strict --noUncheckedIndexedAccess` is enforced.
- Small, focused files. `src/core/*.ts` files stay under ~400 lines.
- Pure functions in `core/`. Side effects (spawn, fs) at the edges.
- Prefer adding a test that fails before your fix to documenting the bug in a comment.

## Filing a bug

Please include:

- Windows version (`winver`)
- Node version (`node --version`)
- Output of `paat doctor --json`
- Steps to reproduce
- What you expected vs what happened

## License

By contributing, you agree your changes are licensed under the project's
[MIT license](LICENSE).
