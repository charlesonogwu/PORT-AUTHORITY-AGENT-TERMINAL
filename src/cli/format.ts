import { DEFAULT_SESSION_ID, Lane, laneSessionId } from "../core/lane.js";

const COLS: { key: keyof Lane | "appPortStr" | "chromePortStr" | "sessionStr" | "profileStr"; label: string; width: number }[] = [
  { key: "owner", label: "OWNER", width: 10 },
  { key: "project", label: "PROJECT", width: 18 },
  { key: "sessionStr", label: "SESSION", width: 14 },
  { key: "appPortStr", label: "APP", width: 5 },
  { key: "chromePortStr", label: "CHROME", width: 7 },
  { key: "status", label: "STATUS", width: 9 },
  { key: "profileStr", label: "SAVED PROFILE", width: 22 },
  { key: "cwd", label: "CWD", width: 32 },
];

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

export function formatLanesTable(lanes: Lane[]): string {
  const header = COLS.map((c) => pad(c.label, c.width)).join("  ");
  const rows = lanes.map((lane) => {
    return COLS.map((c) => {
      let value: string;
      if (c.key === "appPortStr") value = lane.appPort ? String(lane.appPort) : "-";
      else if (c.key === "chromePortStr") value = lane.chromeDebugPort ? String(lane.chromeDebugPort) : "-";
      else if (c.key === "sessionStr") {
        const s = laneSessionId(lane);
        value = s === DEFAULT_SESSION_ID ? "-" : s;
      } else if (c.key === "profileStr") {
        value = lane.profileLabel ?? lane.profilePurposes?.join(",") ?? "-";
      } else value = String((lane as unknown as Record<string, unknown>)[c.key] ?? "-");
      return pad(value, c.width);
    }).join("  ");
  });
  return [header, ...rows].join("\n");
}

export function formatReserveBlock(lane: Lane): string {
  const lines: string[] = [];
  lines.push("Assigned lane:");
  lines.push(`  Owner:           ${lane.owner}`);
  lines.push(`  Project:         ${lane.project}`);
  const session = laneSessionId(lane);
  if (session !== DEFAULT_SESSION_ID) lines.push(`  Session:         ${session}`);
  lines.push(`  CWD:             ${lane.cwd}`);
  if (typeof lane.appPort === "number") lines.push(`  App port:        ${lane.appPort}`);
  if (typeof lane.chromeDebugPort === "number") lines.push(`  Chrome debug:    ${lane.chromeDebugPort}`);
  lines.push(`  Chrome profile:  ${lane.chromeProfileDir}`);
  if (lane.task) lines.push(`  Task:            ${lane.task}`);
  lines.push("");
  if (typeof lane.chromeDebugPort === "number") {
    lines.push("PowerShell:");
    lines.push(`  $env:CHROME_DEBUG_PORT="${lane.chromeDebugPort}"`);
    lines.push(`  $env:CHROME_PROFILE_DIR="${lane.chromeProfileDir}"`);
    if (typeof lane.appPort === "number") lines.push(`  $env:APP_PORT="${lane.appPort}"`);
    lines.push("");
    lines.push("Bash:");
    lines.push(`  export CHROME_DEBUG_PORT=${lane.chromeDebugPort}`);
    lines.push(`  export CHROME_PROFILE_DIR=${JSON.stringify(lane.chromeProfileDir)}`);
    if (typeof lane.appPort === "number") lines.push(`  export APP_PORT=${lane.appPort}`);
    lines.push("");
    lines.push("Agent instruction:");
    lines.push(`  Before using Chrome automation, run:`);
    lines.push(`    portpilot check --owner ${lane.owner} --cwd ${JSON.stringify(lane.cwd)}`);
  }
  return lines.join("\n");
}
