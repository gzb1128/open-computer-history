import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { diagnose } from "../src/diagnostics.ts";
import { mcpEndpoint } from "../src/contract.ts";

function plist(label: string, executable: string): string {
  const escaped = (value: string) => value.replaceAll("&", "&amp;");
  return `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${escaped(label)}</string><key>ProgramArguments</key><array><string>${escaped(executable)}</string></array></dict></plist>`;
}

test("doctor separates installed services, collector evidence, MCP reachability, and client injection", async (t) => {
  const userHome = await mkdtemp(join(tmpdir(), "history & doctor-"));
  const home = join(userHome, ".open-codex-computer-history");
  const app = join(userHome, ".local/share/Open Computer History.app/Contents/MacOS/open-history");
  const runtime = join(userHome, ".local/share/open-computer-history/runtime");
  const create = async (path: string, content = "") => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  t.after(() => rm(userHome, { recursive: true, force: true }));
  await create(app);
  await create(join(runtime, ".mcp-use/build/index.js"));
  await create(join(runtime, "node_modules/@mcp-use/cli/dist/bin.js"));
  for (const [name, program] of [
    ["collector", app],
    ["menu", join(userHome, ".local/share/Open Computer History.app/Contents/MacOS/Open Computer History")],
    ["mcp", runtime],
  ]) {
    await create(join(userHome, `Library/LaunchAgents/dev.opencomputerhistory.${name}.plist`), plist(`dev.opencomputerhistory.${name}`, program));
  }
  await create(join(home, "runtime.json"), JSON.stringify({
    state: "stopped", accessibility: false, inputMonitoring: true,
    permissionCheckedAt: "2026-09-28T00:00:00Z",
  }));
  await create(join(home, "collector.stderr.log"), "Accessibility permission required\n");
  const events = join(home, "segments", "one", "events.jsonl");
  await create(events, '{"keyboard":{"text":"TOP SECRET CAPTURED TEXT"}}\n');
  await utimes(events, new Date("2026-09-27T00:00:00Z"), new Date("2026-09-27T00:00:00Z"));

  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
    methods.push(body.method);
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
      : body.method === "tools/list" ? { tools: [{ name: "computer_history_status" }] }
        : { content: [{ type: "text", text: "stopped" }] };
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", "fixture-session");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const report = await diagnose({
    userHome, home, now: new Date("2026-09-28T00:00:00Z"),
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    agentLoaded: async () => true,
  });
  assert.equal(report.installation.app.ok, true);
  assert.equal(report.installation.runtime.ok, true);
  assert.equal(report.installation.collectorAgent.ok, true, "XML entities in a home path must be parsed");
  assert.equal(report.collector.state, "stopped");
  assert.equal(report.collector.process.ok, false);
  assert.equal(report.collector.permissions.accessibility, false, "stopped collector denial remains diagnostic evidence");
  assert.match(report.collector.permissions.check.reason, /last reported/);
  assert.equal(report.collector.startupCause, "Accessibility permission required");
  assert.equal(report.mcp.reachable.ok, true);
  assert.equal(report.mcp.handshake.ok, true);
  assert.equal(report.mcp.readOnlyCall.ok, true);
  assert.equal(report.mcp.clientInjected.ok, null);
  assert.equal(report.data.check.ok, null, "idle data is not a fault");
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.ok(!JSON.stringify(report).includes("TOP SECRET"));
  assert.equal(report.summaries.enabled, false);
});

test("doctor reports endpoint HTTP 500 as reachable with a failed handshake", async (t) => {
  const userHome = await mkdtemp(join(tmpdir(), "history-doctor-500-"));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const server = createServer((_req, res) => res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Response body object should not be disturbed or locked" } })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const report = await diagnose({ userHome, home: join(userHome, "history"), endpoint: `http://127.0.0.1:${address.port}/mcp`, agentLoaded: async () => false });
  assert.equal(report.mcp.reachable.ok, true);
  assert.equal(report.mcp.handshake.ok, false);
  assert.match(report.mcp.handshake.reason, /disturbed or locked/);
  assert.equal(report.collector.process.ok, null, "an intentional clean stop is informational");
});

test("an explicitly invalid MCP port fails instead of falling back", () => {
  assert.throws(() => mcpEndpoint(0), /Invalid OPEN_HISTORY_MCP_PORT/);
});
