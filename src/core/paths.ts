import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Resolves filesystem locations used by portpilot. All functions read the
 * environment lazily so tests can override locations via PORTPILOT_HOME.
 */

export function portpilotHome(): string {
  const override = process.env.PORTPILOT_HOME;
  if (override && override.trim().length > 0) return override;
  const home = homedir();
  return join(home, ".portpilot");
}

export function registryPath(): string {
  return join(portpilotHome(), "lanes.json");
}

export function lockPath(): string {
  return join(portpilotHome(), "lanes.json.lock");
}

export function profilesDir(): string {
  return join(portpilotHome(), "profiles");
}

/**
 * Compose a deterministic Chrome profile directory for a lane.
 * - sessionId: distinguishes parallel sessions for the same (owner, project).
 *   When sessionId is "default" or missing, it is omitted from the slug so
 *   single-session installations have stable, short paths.
 * - dedupeSuffix: a numeric suffix added when another lane in the registry
 *   already owns the deterministic path (rare; e.g. two cwds with the same
 *   project name).
 */
export function profileDirFor(
  ownerSlug: string,
  projectSlug: string,
  options: { sessionId?: string; dedupeSuffix?: string } | string = {},
): string {
  // Backwards-compat for the previous third-positional `suffix` argument.
  const opts = typeof options === "string" ? { dedupeSuffix: options } : options;
  const session = opts.sessionId && opts.sessionId !== "default" ? `-${opts.sessionId}` : "";
  const dedupe = opts.dedupeSuffix ? `-${opts.dedupeSuffix}` : "";
  return join(profilesDir(), `${ownerSlug}-${projectSlug}${session}${dedupe}`);
}

export function isWindows(): boolean {
  return platform() === "win32";
}
