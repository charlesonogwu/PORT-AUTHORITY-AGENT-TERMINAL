// Calls collectProcessSnapshot + findAllAgentChromes against the real
// machine state and prints what it finds. Useful for spot-checking the
// new pipe/port-mode enumeration without having to coax a real pipe-mode
// Chrome into staying alive.

import { collectProcessSnapshot } from "../dist/src/dashboard/process-info.js";
import { findAllAgentChromes } from "../dist/src/dashboard/sources.js";

const snap = await collectProcessSnapshot();
console.log(`Win32_Process listing: ${snap.processes.size} processes`);

const chromes = findAllAgentChromes(snap);
console.log(`Agent-driven Chromes detected: ${chromes.length}`);
for (const c of chromes) {
  console.log(`  pid=${c.pid}  mode=${c.debugMode}  port=${c.port}  profile=${c.profileDir ?? "(none)"}`);
  console.log(`    cmd: ${(c.commandLine ?? "").slice(0, 180)}`);
}

if (chromes.length === 0) {
  console.log("\nNo agent-driven Chrome processes are currently running.");
  console.log("Try running this AFTER asking an agent to do a browser task.");
}
