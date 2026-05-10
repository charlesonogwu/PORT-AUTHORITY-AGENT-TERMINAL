import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a fresh PORTPILOT_HOME for each test so registry / lockfile state
 * never leaks between tests or into the user's real ~/.portpilot directory.
 */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "portpilot-test-"));
  const original = process.env.PORTPILOT_HOME;
  process.env.PORTPILOT_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (original === undefined) delete process.env.PORTPILOT_HOME;
    else process.env.PORTPILOT_HOME = original;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
