import { realpath, stat } from "node:fs/promises";
import { relative, isAbsolute, resolve } from "node:path";
import { Lane, normalizeCwd, nowIso } from "./lane.js";
import { profilesDir } from "./paths.js";
import { listLanes, updateRegistry } from "./registry.js";

/** Retain only the exact site host; never store URL paths, queries or credentials. */
export function normalizeLoginWebsite(value: string): string {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) throw new Error("provide a website hostname or HTTP(S) URL");
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error("website must be HTTP(S) and contain no credentials");
  }
  return url.host.toLowerCase();
}

async function verifyProfile(profile: string): Promise<void> {
  const root = await realpath(profilesDir());
  const target = await realpath(profile);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel) || !(await stat(target)).isDirectory()) {
    throw new Error("saved login requires an existing isolated PortPilot profile");
  }
  const lexical = relative(resolve(profilesDir()), resolve(profile));
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) throw new Error("profile outside PortPilot profiles");
}

function accountNickname(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const label = value.trim();
  if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error("provide an account nickname of 1–80 characters");
  return label;
}

export async function rememberSavedLogin(laneId: string, input: { website: string; confirmed: boolean; accountLabel?: string }): Promise<Lane> {
  if (input.confirmed !== true) throw new Error("saved login requires explicit user confirmation");
  const website = normalizeLoginWebsite(input.website);
  const accountLabel = accountNickname(input.accountLabel);
  let result: Lane | undefined;
  await updateRegistry(async lanes => {
    const lane = lanes.find(l => l.id === laneId);
    if (!lane) throw new Error("unknown immutable PPID");
    await verifyProfile(lane.chromeProfileDir);
    const entry = {website, confirmedAt: nowIso(), ...(accountLabel ? {accountLabel} : {})};
    // A browser profile holds one current account context per website.
    result = {...lane, savedLogins: [...(lane.savedLogins ?? []).filter(l => l.website !== website), entry]};
    return lanes.map(l => l.id === laneId ? result! : l);
  });
  return result!;
}
export async function findSavedLogins(input: {cwd: string; website: string; accountLabel?: string}): Promise<{lanes: Lane[]; unavailableProfileIds: string[]; reconnect: {laneId: string; command: string} | null}> {
  if (!input.cwd.trim()) throw new Error("workspace cwd must not be blank");
  const cwd = normalizeCwd(input.cwd);
  const website = normalizeLoginWebsite(input.website);
  const accountLabel = accountNickname(input.accountLabel);
  const lanes: Lane[] = [];
  const unavailableProfileIds: string[] = [];
  for (const lane of await listLanes()) {
    if (normalizeCwd(lane.cwd) !== cwd || !(lane.savedLogins ?? []).some(l => l.website === website && (!accountLabel || l.accountLabel === accountLabel))) continue;
    lanes.push(lane);
    try { await verifyProfile(lane.chromeProfileDir); } catch { unavailableProfileIds.push(lane.id); }
  }
  return {lanes, unavailableProfileIds, reconnect: lanes.length === 1 && unavailableProfileIds.length === 0 ? {laneId: lanes[0]!.id, command: `portpilot open --lane-id ${lanes[0]!.id}`} : null};
}
