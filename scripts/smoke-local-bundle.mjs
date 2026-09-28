#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "dist/Open Computer History Bundle");
const scratch = await mkdtemp(join(tmpdir(), "open-history-bundle-smoke-"));
const bundle = join(scratch, "bundle with spaces");
let child;

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function request(endpoint, method, params, session) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(1000),
  });
  const body = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/u).map((event) => event.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")).filter(Boolean).at(-1)
    : body;
  const result = JSON.parse(payload ?? "");
  if (!response.ok || result.error || !result.result) throw new Error(`MCP ${method} failed: ${body.slice(0, 400)}`);
  return { result: result.result, session: response.headers.get("mcp-session-id") ?? session };
}

try {
  await cp(source, bundle, { recursive: true });
  const runtime = join(bundle, "runtime");
  const app = join(bundle, "Open Computer History.app");
  const manifest = JSON.parse(await readFile(join(runtime, ".mcp-use/build/manifest.json"), "utf8"));
  for (const [name, view] of Object.entries(manifest.views ?? {})) {
    await access(join(runtime, ".mcp-use/build/views", name, view.entry));
    for (const css of view.css ?? []) await access(join(runtime, ".mcp-use/build/views", name, css));
  }
  await access(join(app, "Contents/MacOS/open-history"));
  await access(join(runtime, "bin/doctor.mjs"));
  await access(join(bundle, "scripts/install-local.sh"));
  const plan = spawnSync(join(bundle, "scripts/install-local.sh"), ["--plan", "--home", scratch], {
    encoding: "utf8", cwd: scratch,
  });
  if (plan.status !== 0 || JSON.parse(plan.stdout).runtime !== join(scratch, ".local/share/open-computer-history/runtime")) {
    throw new Error(`Relocated bundle installer plan failed: ${plan.stderr}`);
  }
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const output = [];
  child = spawn(process.execPath, [
    join(runtime, "node_modules/@mcp-use/cli/dist/bin.js"),
    "start", "--host", "127.0.0.1", "--port", String(port), "--path", runtime,
  ], {
    cwd: runtime,
    env: {
      ...process.env,
      HOME: scratch,
      OPEN_COMPUTER_HISTORY_HOME: join(scratch, "history"),
      OPEN_HISTORY_COLLECTOR_BIN: join(app, "Contents/MacOS/open-history"),
      OPEN_HISTORY_MCP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 100) output.shift();
    });
  }
  let initialized;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged MCP exited: ${output.join("").slice(-2000)}`);
    try {
      initialized = await request(endpoint, "initialize", {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "bundle-smoke", version: "1" },
      });
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  if (!initialized) throw new Error(`Packaged MCP did not start: ${output.join("").slice(-2000)}`);
  const session = initialized.session;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error(`MCP initialized notification HTTP ${response.status}`);
  const listed = await request(endpoint, "tools/list", undefined, session);
  if (!listed.result.tools?.some((tool) => tool.name === "computer_history_status")) throw new Error("Packaged status tool is missing");
  const status = await request(endpoint, "tools/call", { name: "computer_history_status", arguments: {} }, session);
  if (status.result.isError) throw new Error(`Packaged status tool failed: ${JSON.stringify(status.result)}`);
  const doctor = spawnSync(process.execPath, [join(runtime, "bin/doctor.mjs"), "--json"], {
    cwd: runtime,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: scratch,
      OPEN_COMPUTER_HISTORY_HOME: join(scratch, "history"),
      OPEN_HISTORY_COLLECTOR_BIN: join(app, "Contents/MacOS/open-history"),
      OPEN_HISTORY_MCP_PORT: String(port),
    },
  });
  if (!doctor.stdout.trim()) {
    throw new Error(`Packaged doctor produced no JSON (exit ${doctor.status}, signal ${doctor.signal}): ${doctor.error?.message ?? doctor.stderr}`);
  }
  const report = JSON.parse(doctor.stdout);
  if (report.mcp.handshake.ok !== true || report.mcp.readOnlyCall.ok !== true) {
    throw new Error(`Packaged doctor could not inspect the MCP endpoint: ${doctor.stderr}\n${doctor.stdout}`);
  }
  console.log(`Relocated bundle MCP smoke passed on port ${port}; app and view assets present.`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      new Promise((done) => setTimeout(done, 1500)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(scratch, { recursive: true, force: true });
}
