import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import test from "node:test";
import { probePort } from "../src/core/port-probe.js";

function listen(host: string, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  return address.port;
}

test("probePort reports a live IPv4 loopback listener as busy", async () => {
  const server = await listen("127.0.0.1");
  try {
    assert.equal(await probePort(portOf(server)), "busy");
  } finally {
    await close(server);
  }
});

test("probePort reports a port nobody holds as free", async () => {
  const server = await listen("127.0.0.1");
  const port = portOf(server);
  await close(server);
  assert.equal(await probePort(port), "free");
});

test("probePort reports an IPv6-loopback-only listener as busy", async (t) => {
  let server: Server;
  try {
    server = await listen("::1");
  } catch {
    t.skip("IPv6 loopback is unavailable on this machine");
    return;
  }
  try {
    assert.equal(await probePort(portOf(server)), "busy");
  } finally {
    await close(server);
  }
});

test("probePort answers unknown for impossible port numbers instead of guessing", async () => {
  assert.equal(await probePort(0), "unknown");
  assert.equal(await probePort(70_000), "unknown");
  assert.equal(await probePort(1.5), "unknown");
});
