import { spawn } from "node:child_process";
import { startSupervisorServer } from "../../src/supervisor/server.js";

const home = process.argv[2];
if (!home) throw new Error("missing home");

let childPid: number | undefined;
await startSupervisorServer({
  home,
  supervisorId: "fixture-supervisor",
  handlers: {
    launch: async ({ laneId }) => {
      if (childPid) {
        try {
          process.kill(childPid, 0);
          return { laneId, pid: childPid, reused: true };
        } catch {
          childPid = undefined;
        }
      }
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      childPid = child.pid;
      child.unref();
      return { laneId, pid: childPid, reused: false };
    },
    close: async ({ laneId }) => {
      if (!childPid) return { laneId, closed: false };
      try { process.kill(childPid); } catch { return { laneId, closed: false }; }
      childPid = undefined;
      return { laneId, closed: true };
    },
  },
});

await new Promise(() => {});
