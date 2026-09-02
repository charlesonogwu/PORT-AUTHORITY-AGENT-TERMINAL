import { writeFile } from "node:fs/promises";
import { createSupervisorClient } from "../../src/supervisor/client.js";

const home = process.argv[2];
const resultPath = process.argv[3];
if (!home || !resultPath) throw new Error("missing fixture arguments");

const result = await createSupervisorClient({ home, timeoutMs: 2_000 }).launch({ laneId: "synthetic-lane" });
await writeFile(resultPath, JSON.stringify(result), "utf8");
await new Promise(() => {});
