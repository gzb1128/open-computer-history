import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { historyHome } from "./history-store.js";
import { recorderStatus, type RecorderRuntimeStatus } from "./runtime-control.js";
import {
  COLLECTOR_LAUNCH_AGENT,
  MCP_LAUNCH_AGENT,
  MENU_LAUNCH_AGENT,
  PIPELINE_LAUNCH_AGENT,
  mcpEndpoint,
} from "./contract.js";

export interface DiagnosticCheck {
  ok: boolean | null;
  reason: string;
  action?: string;
}

export interface Diagnostics {
  checkedAt: string;
  installation: {
    app: DiagnosticCheck;
    runtime: DiagnosticCheck;
    collectorAgent: DiagnosticCheck;
    menuAgent: DiagnosticCheck;
  };
  collector: {
    state: "stopped" | "running" | "paused";
    process: DiagnosticCheck;
    startupCause: string | null;
    permissions: {
      accessibility: boolean | null;
      inputMonitoring: boolean | null;
      checkedAt: string | null;
      source: "collector" | "unknown";
      check: DiagnosticCheck;
    };
  };
  mcp: {
    endpoint: string;
    agent: DiagnosticCheck;
    reachable: DiagnosticCheck;
    handshake: DiagnosticCheck;
    readOnlyCall: DiagnosticCheck;
    clientInjected: DiagnosticCheck;
  };
  data: {
    segmentCount: number;
    latestWriteAt: string | null;
    check: DiagnosticCheck;
  };
  summaries: {
    enabled: boolean;
    agent: DiagnosticCheck;
    lastCompletedAt: string | null;
    check: DiagnosticCheck;
  };
  clientConfig: { mcpServers: { "computer-history": { url: string } } };
}

export interface DiagnoseOptions {
  userHome?: string;
  home?: string;
  endpoint?: string;
  now?: Date;
  fetch?: typeof fetch;
  agentLoaded?: (label: string) => Promise<boolean>;
}

const yes = (reason: string): DiagnosticCheck => ({ ok: true, reason });
const no = (reason: string, action: string): DiagnosticCheck => ({ ok: false, reason, action });
const unknown = (reason: string, action?: string): DiagnosticCheck => ({ ok: null, reason, ...(action ? { action } : {}) });

export async function diagnose(options: DiagnoseOptions = {}): Promise<Diagnostics> {
  const userHome = options.userHome ?? homedir();
  const home = options.home ?? (options.userHome ? join(userHome, ".open-codex-computer-history") : historyHome());
  const now = options.now ?? new Date();
  const launchDirectory = join(userHome, "Library", "LaunchAgents");
  const endpoint = options.endpoint ?? mcpEndpoint(process.env.OPEN_HISTORY_MCP_PORT === undefined
    ? await installedMCPPort(launchDirectory) : undefined);
  const appExecutable = join(userHome, ".local/share/Open Computer History.app/Contents/MacOS/open-history");
  const runtime = join(userHome, ".local/share/open-computer-history/runtime");
  const collectorAgent = await agentCheck(launchDirectory, COLLECTOR_LAUNCH_AGENT, appExecutable, options.agentLoaded);
  const menuAgent = await agentCheck(launchDirectory, MENU_LAUNCH_AGENT, "Open Computer History.app", options.agentLoaded);
  const mcpAgent = await agentCheck(launchDirectory, MCP_LAUNCH_AGENT, runtime, options.agentLoaded);
  const pipelineAgent = await agentCheck(launchDirectory, PIPELINE_LAUNCH_AGENT, runtime, options.agentLoaded);
  const summaryEnabled = await exists(join(launchDirectory, `${PIPELINE_LAUNCH_AGENT}.plist`));
  let status: Pick<RecorderRuntimeStatus, "state" | "processIdentifier">;
  let statusError: string | null = null;
  try {
    status = await readStatus(home, options.home !== undefined || options.userHome !== undefined,
      await exists(appExecutable) ? appExecutable : undefined);
  } catch (error) {
    status = { state: "stopped" };
    statusError = error instanceof Error ? error.message : String(error);
  }
  const runtimeData = await readJSON(join(home, "runtime.json"));
  const pid = status.processIdentifier;
  const live = status.state !== "stopped" && Number.isInteger(pid) && (pid ?? 0) > 0;
  const permissionEvidence = runtimeData && typeof runtimeData.accessibility === "boolean" &&
    typeof runtimeData.inputMonitoring === "boolean" && typeof runtimeData.permissionCheckedAt === "string"
    ? runtimeData : null;
  const permissions = permissionEvidence
    ? {
      accessibility: permissionEvidence.accessibility as boolean,
      inputMonitoring: permissionEvidence.inputMonitoring as boolean,
      checkedAt: permissionEvidence.permissionCheckedAt as string,
      source: "collector" as const,
      check: !permissionEvidence.accessibility || !permissionEvidence.inputMonitoring
        ? no(`${live ? "The live collector reports" : "The collector last reported"} a missing macOS permission.`, "Grant Accessibility and Input Monitoring to the installed Open Computer History.app.")
        : live ? yes("The live collector reported both permissions.")
          : unknown("The stopped collector last reported both permissions; current grants are unverified.", "Start the collector to check current permission state."),
    }
    : {
      accessibility: null,
      inputMonitoring: null,
      checkedAt: null,
      source: "unknown" as const,
      check: unknown("No live collector permission report is available.", "Start the installed collector, then run doctor again."),
    };
  const startupCause = live ? null : await lastStartupCause(
    join(home, "collector.stderr.log"),
    typeof runtimeData?.endedAt === "string" ? runtimeData.endedAt
      : typeof runtimeData?.startedAt === "string" ? runtimeData.startedAt : null,
  );
  const staleRuntime = !live && (runtimeData?.state === "running" || runtimeData?.state === "paused");
  const data = await dataCheck(home, now);
  const summary = await summaryCheck(home, summaryEnabled, pipelineAgent);
  const mcp = await probeMCP(endpoint, options.fetch ?? fetch);

  return {
    checkedAt: now.toISOString(),
    installation: {
      app: await exists(appExecutable) ? yes("The installed collector executable exists.") : no("The installed collector executable is missing.", "Run npm run install:local."),
      runtime: await exists(join(runtime, ".mcp-use/build/index.js")) && await exists(join(runtime, "node_modules/@mcp-use/cli/dist/bin.js"))
        ? yes("The installed MCP runtime and its dependencies exist.")
        : no("The installed MCP runtime is incomplete.", "Run npm run install:local."),
      collectorAgent,
      menuAgent,
    },
    collector: {
      state: status.state,
      process: statusError ? no(`Collector status check failed: ${statusError}`, "Inspect the installed collector executable and its error output.")
        : live ? yes(`Collector process ${pid} is alive.`)
        : staleRuntime ? no("Saved recorder state claims a process that is no longer the live collector.", "Inspect the collector error log before restarting.")
          : startupCause || permissions.check.ok === false
            ? no("The collector is stopped after an observed error or permission denial.", "Review the collector cause and permissions before restarting.")
            : unknown("The collector is stopped; this is expected before the first Start or after Stop."),
      startupCause,
      permissions,
    },
    mcp: {
      endpoint,
      agent: mcpAgent,
      ...mcp,
      clientInjected: unknown("A local endpoint cannot establish whether this client injected its tools.", "Check the active client's MCP tool list after configuring the printed endpoint."),
    },
    data,
    summaries: summary,
    clientConfig: { mcpServers: { "computer-history": { url: endpoint } } },
  };
}

async function readStatus(home: string, isolatedHome: boolean, installedBinary?: string): Promise<Pick<RecorderRuntimeStatus, "state" | "processIdentifier">> {
  if (!isolatedHome) return recorderStatus({ installedBinary });
  const saved = await readJSON(join(home, "runtime.json"));
  const state = saved?.state === "running" || saved?.state === "paused" ? saved.state : "stopped";
  const pid = Number.isSafeInteger(saved?.processIdentifier) && (saved?.processIdentifier as number) > 0
    ? saved?.processIdentifier as number : undefined;
  if (state === "stopped" || !pid || !processAlive(pid)) return { state: "stopped" as const, processIdentifier: undefined };
  return { state: state as "running" | "paused", processIdentifier: pid };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function agentCheck(directory: string, label: string, expectedPath: string, loadedOverride?: (label: string) => Promise<boolean>): Promise<DiagnosticCheck> {
  const path = join(directory, `${label}.plist`);
  if (!await exists(path)) {
    return no(`${label} LaunchAgent is not installed.`, "Run npm run install:local.");
  }
  let plist: { Label?: string; ProgramArguments?: string[] };
  try {
    plist = await readPlist(path);
  } catch (error) {
    return no(`${label} LaunchAgent plist could not be parsed: ${error instanceof Error ? error.message : String(error)}`, "Reinstall the local services and inspect the plist.");
  }
  if (plist.Label !== label || !plist.ProgramArguments?.some((arg) => arg.includes(expectedPath))) {
    return no(`${label} LaunchAgent has an unexpected label or program path.`, "Reinstall the local services and inspect the plist.");
  }
  const loaded = loadedOverride ? await loadedOverride(label) : await defaultAgentLoaded(label);
  return loaded ? yes(`${label} LaunchAgent is installed and loaded.`) : no(`${label} LaunchAgent is installed but not loaded.`, `Inspect launchctl print gui/${process.getuid?.()}/${label}.`);
}

async function installedMCPPort(directory: string): Promise<number | undefined> {
  try {
    const plist = await readPlist(join(directory, `${MCP_LAUNCH_AGENT}.plist`));
    const value = plist.EnvironmentVariables?.OPEN_HISTORY_MCP_PORT;
    return value === undefined ? undefined : Number(value);
  } catch { return undefined; }
}

async function readPlist(path: string): Promise<{
  Label?: string;
  ProgramArguments?: string[];
  EnvironmentVariables?: Record<string, string>;
}> {
  const { stdout } = await promisify(execFile)("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { timeout: 1500 });
  return JSON.parse(stdout);
}

async function defaultAgentLoaded(label: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await promisify(execFile)("/bin/launchctl", ["print", `gui/${process.getuid?.()}/${label}`], { timeout: 1500 });
    return true;
  } catch { return false; }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readJSON(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function lastStartupCause(path: string, after: string | null): Promise<string | null> {
  try {
    const since = after ? Date.parse(after) : NaN;
    if (Number.isFinite(since) && (await stat(path)).mtimeMs < since) return null;
    const log = await readFile(path, "utf8");
    return log.slice(-4096).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1) ?? null;
  } catch { return null; }
}

async function dataCheck(home: string, now: Date): Promise<Diagnostics["data"]> {
  const root = join(home, "segments");
  let segmentCount = 0;
  let latest = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const events = join(root, entry.name, "events.jsonl");
    try {
      const info = await stat(events);
      segmentCount++;
      latest = Math.max(latest, info.mtimeMs);
    } catch { /* A segment can be rotated while doctor runs. */ }
  }
  const latestWriteAt = latest ? new Date(latest).toISOString() : null;
  const check = !latestWriteAt
    ? unknown("No event segment has been written yet.", "Start the collector and check permissions.")
    : now.getTime() - latest > 15 * 60_000
      ? unknown("The newest event segment has not changed in over 15 minutes; idle or paused recording can explain this.", "Check collector state if you expected recent activity.")
      : yes("An event segment was written within 15 minutes.");
  return { segmentCount, latestWriteAt, check };
}

async function summaryCheck(home: string, enabled: boolean, agent: DiagnosticCheck): Promise<Diagnostics["summaries"]> {
  if (!enabled) return { enabled: false, agent: unknown("The optional summary LaunchAgent is not installed."), lastCompletedAt: null, check: unknown("Summaries are disabled.") };
  const state = await readJSON(join(home, "pipeline-state.json"));
  const buckets = state?.buckets && typeof state.buckets === "object" ? Object.values(state.buckets) : [];
  const completed = buckets.filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && (value as Record<string, unknown>).status === "completed");
  const lastCompletedAt = completed.map((bucket) => bucket.end).filter((value): value is string => typeof value === "string").sort().at(-1) ?? null;
  return {
    enabled: true,
    agent,
    lastCompletedAt,
    check: agent.ok === false ? no("The summary LaunchAgent is not loaded.", "Inspect the pipeline LaunchAgent and its error log.")
      : lastCompletedAt ? yes("The optional pipeline has completed a summary bucket.")
        : unknown("The optional pipeline has no completed summary bucket.", "Inspect pipeline-state.json and the pipeline error log if activity should have been summarized."),
  };
}

async function probeMCP(endpoint: string, fetchImpl: typeof fetch): Promise<Pick<Diagnostics["mcp"], "reachable" | "handshake" | "readOnlyCall">> {
  let session: string | null = null;
  let nextID = 0;
  async function request(method: string, params?: Record<string, unknown>) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextID, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(2500),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const body = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split(/\r?\n\r?\n/u).map((event) => event.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")).filter(Boolean).at(-1)
      : body;
    let value: Record<string, unknown> | null = null;
    try { value = JSON.parse(payload ?? "") as Record<string, unknown>; } catch { /* Keep HTTP cause below. */ }
    if (!response.ok || value?.error) {
      const detail = value?.error && typeof value.error === "object" && "message" in value.error ? String(value.error.message) : body.slice(0, 256);
      throw new Error(`MCP ${method} HTTP ${response.status}: ${detail}`);
    }
    if (!value || value.id !== nextID || !("result" in value)) throw new Error(`MCP ${method} returned no matching JSON-RPC result.`);
    return value.result;
  }
  async function initializedNotification() {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`MCP notifications/initialized HTTP ${response.status}: ${(await response.text()).slice(0, 256)}`);
  }
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "open-history-doctor", version: "1" } });
    if (!initialized || typeof initialized !== "object") throw new Error("MCP initialize returned no server capabilities.");
    await initializedNotification();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const network = error instanceof TypeError || cause.includes("fetch failed");
    return {
      reachable: network ? no(`MCP endpoint is unreachable: ${cause}`, "Start the installed MCP LaunchAgent.") : yes("MCP endpoint responded."),
      handshake: no(`MCP handshake failed: ${cause}`, "Inspect the MCP LaunchAgent error log and runtime build."),
      readOnlyCall: unknown("No read-only call was attempted because the handshake failed."),
    };
  }
  try {
    const listed = await request("tools/list");
    const tools = listed && typeof listed === "object" && "tools" in listed ? listed.tools : undefined;
    if (!Array.isArray(tools) || !tools.some((tool) => tool && typeof tool === "object" && tool.name === "computer_history_status")) {
      throw new Error("The compatibility read-only status tool is missing from tools/list.");
    }
    const called = await request("tools/call", { name: "computer_history_status", arguments: {} });
    if (!called || typeof called !== "object" || ("isError" in called && called.isError === true)) {
      const content = called && typeof called === "object" && "content" in called && Array.isArray(called.content)
        ? called.content.filter((item): item is { text: string } => !!item && typeof item === "object" && typeof item.text === "string").map((item) => item.text).join("; ") : "";
      throw new Error(`The read-only status tool returned an error${content ? `: ${content}` : "."}`);
    }
    return { reachable: yes("MCP endpoint responded."), handshake: yes("MCP initialize succeeded."), readOnlyCall: yes("MCP compatibility status tool was called successfully.") };
  } catch (error) {
    return {
      reachable: yes("MCP endpoint responded."),
      handshake: yes("MCP initialize succeeded."),
      readOnlyCall: no(`MCP read-only status call failed: ${error instanceof Error ? error.message : String(error)}`, "Inspect the MCP LaunchAgent error log and tool registration."),
    };
  }
}
