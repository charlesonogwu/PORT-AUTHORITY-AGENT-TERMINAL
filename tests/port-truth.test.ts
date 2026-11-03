import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmObservations,
  executableName,
  selectDebugPortOwner,
  type ProcessRecord,
} from "../src/core/port-truth.js";
import { parseUnixDebugPortProcesses, parseWindowsProcessJson, type PortObservation } from "../src/core/scanner.js";

function chromeMain(port: number, profile: string, pid = 4000): ProcessRecord {
  return {
    pid,
    name: "chrome.exe",
    commandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port} --user-data-dir=${profile} --no-first-run`,
    startedAt: "2026-11-03T07:51:29.6088190Z",
  };
}

test("selectDebugPortOwner picks the browser process that serves the port, not its children", () => {
  const processes: ProcessRecord[] = [
    {
      pid: 54472,
      name: "chrome.exe",
      commandLine: `"chrome.exe" --type=renderer --user-data-dir="C:\\pp\\profiles\\a" --remote-debugging-port=9322`,
    },
    chromeMain(9322, "C:\\pp\\profiles\\a", 47648),
    chromeMain(93220, "C:\\pp\\profiles\\b", 1),
  ];
  assert.equal(selectDebugPortOwner(processes, 9322)?.pid, 47648);
  assert.equal(selectDebugPortOwner(processes, 9320), undefined);
});

test("selectDebugPortOwner understands Firefox's space-separated flag and skips content processes", () => {
  const processes: ProcessRecord[] = [
    { pid: 10, name: "firefox.exe", commandLine: `"firefox.exe" -profile C:\\pp\\profiles\\ff --remote-debugging-port 9330 --no-remote` },
    { pid: 11, name: "firefox.exe", commandLine: `"firefox.exe" -contentproc --channel=x -remote-debugging-port 9330 tab` },
  ];
  assert.equal(selectDebugPortOwner(processes, 9330)?.pid, 10);
});

test("selectDebugPortOwner refuses to guess between two browsers that claim one port", () => {
  const processes = [chromeMain(9322, "C:\\pp\\profiles\\a", 1), chromeMain(9322, "C:\\pp\\profiles\\b", 2)];
  assert.equal(selectDebugPortOwner(processes, 9322), undefined);
});

test("selectDebugPortOwner prefers the browser over the launcher that repeats its flags", () => {
  const processes: ProcessRecord[] = [
    { pid: 900, name: "cmd.exe", commandLine: `cmd.exe /c "chrome.exe --remote-debugging-port=9322 --user-data-dir=C:\\pp\\profiles\\a"` },
    chromeMain(9322, "C:\\pp\\profiles\\a", 901),
  ];
  assert.equal(selectDebugPortOwner(processes, 9322)?.pid, 901);
});

test("parseWindowsProcessJson accepts one object, an array, or nothing", () => {
  const one = parseWindowsProcessJson(JSON.stringify({ ProcessId: 7, Name: "chrome.exe", CommandLine: "chrome.exe --remote-debugging-port=9322", CreationDate: "2026-11-03T07:51:29.6088190Z" }));
  assert.deepEqual(one, [{ pid: 7, name: "chrome.exe", commandLine: "chrome.exe --remote-debugging-port=9322", startedAt: "2026-11-03T07:51:29.6088190Z" }]);
  const many = parseWindowsProcessJson(JSON.stringify([
    { ProcessId: 7, Name: "chrome.exe", CommandLine: "chrome.exe --remote-debugging-port=9322" },
    { ProcessId: 8, Name: "System", CommandLine: null },
  ]));
  assert.deepEqual(many.map((record) => record.pid), [7]);
  assert.deepEqual(parseWindowsProcessJson("  \r\n"), []);
});

test("parseUnixDebugPortProcesses keeps full command lines with spaces in the program path", () => {
  const records = parseUnixDebugPortProcesses([
    "  412 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9322 --user-data-dir=/Users/me/.portpilot/profiles/a",
    "  413 /usr/bin/python3 server.py",
  ].join("\n"));
  assert.equal(records.length, 1);
  assert.equal(records[0]!.pid, 412);
  assert.equal(executableName(records[0]!.commandLine), "Google Chrome");
});

test("executableName reads the program name from quoted and unquoted command lines", () => {
  assert.equal(executableName(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --x`), "chrome.exe");
  assert.equal(executableName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9322"), "Google Chrome");
  assert.equal(executableName("/usr/bin/firefox -profile /tmp/p --remote-debugging-port 9330"), "firefox");
});

test("confirmObservations adds the real owner of a busy port that the listener table left out", async () => {
  const confirmed = await confirmObservations([9322], [], {
    probe: async () => "busy",
    listDebugPortProcesses: async () => [chromeMain(9322, "C:\\pp\\profiles\\opencode-x", 47648)],
  });
  assert.equal(confirmed.length, 1);
  const owner = confirmed[0]!;
  assert.equal(owner.port, 9322);
  assert.equal(owner.pid, 47648);
  assert.equal(owner.command, "chrome.exe");
  assert.match(owner.commandLine ?? "", /opencode-x/);
  assert.equal(owner.processStartedAt, "2026-11-03T07:51:29.6088190Z");
});

test("confirmObservations records an unidentified holder when no browser claims a busy port", async () => {
  const confirmed = await confirmObservations([3000], [], {
    probe: async () => "busy",
    listDebugPortProcesses: async () => [chromeMain(9322, "C:\\pp\\profiles\\a")],
  });
  assert.deepEqual(confirmed, [{ port: 3000, protocol: "tcp", source: "native" }]);
});

test("confirmObservations still records the holder when the process list is unavailable", async () => {
  const confirmed = await confirmObservations([9322], [], {
    probe: async () => "busy",
    listDebugPortProcesses: async () => { throw new Error("powershell timed out"); },
  });
  assert.deepEqual(confirmed, [{ port: 9322, protocol: "tcp", source: "native" }]);
});

test("confirmObservations drops listener-table rows for a port the kernel says is free", async () => {
  const table: PortObservation[] = [
    { port: 9322, pid: 0, source: "native", protocol: "tcp" },
    { port: 5037, pid: 31364, source: "native", protocol: "tcp", command: "adb.exe" },
  ];
  const confirmed = await confirmObservations([9322], table, {
    probe: async () => "free",
    listDebugPortProcesses: async () => { throw new Error("must not list processes for a free port"); },
  });
  assert.deepEqual(confirmed.map((observation) => observation.port), [5037]);
});

test("confirmObservations trusts existing table rows for a busy port without listing processes", async () => {
  const table: PortObservation[] = [{ port: 9322, pid: 47648, source: "native", protocol: "tcp", command: "chrome.exe" }];
  const confirmed = await confirmObservations([9322], table, {
    probe: async () => "busy",
    listDebugPortProcesses: async () => { throw new Error("must not list processes when the table already has the port"); },
  });
  assert.deepEqual(confirmed, table);
});

test("confirmObservations leaves the snapshot alone when the probe cannot tell", async () => {
  const table: PortObservation[] = [{ port: 9322, pid: 47648, source: "native", protocol: "tcp" }];
  assert.deepEqual(await confirmObservations([9322], table, { probe: async () => "unknown" }), table);
  assert.deepEqual(await confirmObservations([9323], [], { probe: async () => "unknown" }), []);
});

test("confirmObservations lists processes once for several missing ports", async () => {
  let listings = 0;
  const confirmed = await confirmObservations([9322, 9323, 9322, undefined], [], {
    probe: async () => "busy",
    listDebugPortProcesses: async () => {
      listings += 1;
      return [chromeMain(9322, "C:\\pp\\profiles\\a", 1), chromeMain(9323, "C:\\pp\\profiles\\b", 2)];
    },
  });
  assert.equal(listings, 1);
  assert.deepEqual(confirmed.map((observation) => [observation.port, observation.pid]), [[9322, 1], [9323, 2]]);
});
