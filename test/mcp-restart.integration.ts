import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MCPClient } from "@mcp-use/client";
import { diagnose } from "../src/diagnostics.ts";

test("a retained MCP client can call a read-only tool on the first request after restart", async (t) => {
  const root = resolve(import.meta.dirname, "..");
  const home = await mkdtemp(join(tmpdir(), "history-mcp-restart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bucketStart = new Date(Math.floor(Date.now() / 600_000) * 600_000 - 600_000);
  const bucketEnd = new Date(bucketStart.getTime() + 600_000);
  const eventAt = new Date(bucketStart.getTime() + 60_000).toISOString();
  await writeFile(join(home, "config.json"), JSON.stringify({ timeZone: "Asia/Shanghai" }));
  await mkdir(join(home, "segments", "fixture"), { recursive: true });
  await writeFile(join(home, "segments", "fixture", "events.jsonl"), `${JSON.stringify({
    id: 1,
    timestamp: eventAt,
    kind: "window.changed",
    app: { name: "Fixture Editor", bundleIdentifier: "com.example.fixture" },
    window: { title: "Timezone fixture planning notes" },
  })}\n`);
  await mkdir(join(home, "memories", "resources"), { recursive: true });
  const memoryName = `${bucketStart.toISOString().replaceAll(":", "-").replace(".000Z", "Z")}-abcd-10min-activity.md`;
  await writeFile(join(home, "memories", "resources", memoryName), [
    "---",
    "title: Timezone fixture planning notes",
    "description: Synthetic historical summary.",
    "applications: [com.example.fixture]",
    "---",
    "## Memory summary",
    "Timezone fixture planning notes.",
  ].join("\n"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const client = new MCPClient({ mcpServers: { fixture: { url } } });
  t.after(() => client.close());
  let child: ChildProcess | undefined;
  t.after(async () => { if (child) await stop(child); });

  async function start() {
    let output = "";
    child = spawn(process.execPath, [
      join(root, "node_modules/@mcp-use/cli/dist/bin.js"), "start", "--host", "127.0.0.1", "--port", String(port), "--path", root,
    ], { cwd: root, env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`MCP server exited during startup: ${output}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(500) });
        if (response.status === 204) return;
      } catch { /* Wait for the bound local test listener. */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`MCP server did not start: ${output}`);
  }

  await start();
  const connection = await client.connect("fixture");
  assert.equal((await connection.callTool("computer_history_status", {})).isError, undefined);
  await stop(child!);
  child = undefined;
  await start();
  const first = await connection.callTool("computer_history_status", {});
  assert.equal(first.isError, undefined, "the retained client must not see an HTTP 500 after restart");
  const timeline = structured(await connection.callTool("show-computer-history", { days: 7 }));
  assert.equal(timeline.timeZone, "Asia/Shanghai");
  const entries = timeline.entries as Record<string, unknown>[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.start, bucketStart.toISOString(), "timeline keeps its UTC identity");
  assert.equal(entries[0]?.end, bucketEnd.toISOString());
  assertLocalTime(entries[0]?.localStart, bucketStart.toISOString());
  assertLocalTime(entries[0]?.localEnd, bucketEnd.toISOString());
  assert.equal(entries[0]?.summaryTimeZone, null, "legacy Markdown has no recorded summary time zone");

  const recent = structured(await connection.callTool("get-recent-computer-history", {
    hours: 2, limit: 10, includeText: false,
  }));
  assert.equal(recent.timeZone, "Asia/Shanghai");
  assert.equal(recent.truncated, false);
  const recentEvents = recent.events as Record<string, unknown>[];
  assert.equal(recentEvents.length, 1);
  assert.equal(recentEvents[0]?.timestamp, eventAt, "raw event timestamp stays UTC");
  assertLocalTime(recentEvents[0]?.localTimestamp, eventAt);
  const rawRecent = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 41, method: "tools/call",
      params: { name: "get-recent-computer-history", arguments: { hours: 2, limit: 1, includeText: false } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(rawRecent.status, 200, "the first raw HTTP request must succeed without client retry");
  const rawBody = await rawRecent.text();
  const rawData = rawBody.split(/\r?\n/u).find((line) => line.startsWith("data:"));
  assert.ok(rawData, "MCP returns a JSON-RPC SSE message");
  const rawMessage = JSON.parse(rawData.slice(5)) as { result?: { structuredContent?: { count?: number; truncated?: boolean } } };
  assert.equal(rawMessage.result?.structuredContent?.count, 1);
  assert.equal(rawMessage.result?.structuredContent?.truncated, false);

  const search = structured(await connection.callTool("search-computer-history", {
    query: "Timezone fixture", hours: 2, limit: 10, includeText: false,
  }));
  assert.equal(search.timeZone, "Asia/Shanghai");
  assert.equal(search.truncated, false);
  const eventMatches = search.eventMatches as Record<string, unknown>[];
  assert.equal(eventMatches.length, 1);
  assert.equal(eventMatches[0]?.timestamp, eventAt);
  assertLocalTime(eventMatches[0]?.localTimestamp, eventAt);
  const memoryMatches = search.memoryMatches as Record<string, unknown>[];
  assert.equal(memoryMatches.length, 1);
  assert.equal(memoryMatches[0]?.summaryTimeZone, null);

  const doctor = await diagnose({ userHome: home, home, endpoint: url, agentLoaded: async () => false });
  assert.equal(doctor.mcp.handshake.ok, true, "doctor negotiates the real server's SSE response");
  assert.equal(doctor.mcp.readOnlyCall.ok, true);
});

function structured(result: { isError?: boolean; structuredContent?: unknown; content?: unknown }): Record<string, unknown> {
  assert.notEqual(result.isError, true, `MCP call failed: ${JSON.stringify(result.content)}`);
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

function assertLocalTime(value: unknown, utc: string): void {
  assert.equal(typeof value, "string");
  assert.match(value as string, /\+08:00$/u);
  assert.equal(new Date(value as string).toISOString(), utc, "local display and UTC value are the same instant");
  const localClock = new Date(Date.parse(utc) + 8 * 60 * 60_000).toISOString().slice(0, 19);
  assert.equal((value as string).slice(0, 19), localClock, "Shanghai display clock is UTC+08:00");
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
