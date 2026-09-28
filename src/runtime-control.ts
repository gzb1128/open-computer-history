import { execFile, spawn } from "node:child_process";
import { access, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { historyHome } from "./history-store.js";

export type RecorderState = "stopped" | "running" | "paused";

export interface RecorderRuntimeStatus {
  state: RecorderState;
  processIdentifier?: number;
  eventStreamRootPath: string;
  currentSegmentEventsPath?: string;
  currentSegmentMetadataPath?: string;
  suppressedEventsPath?: string;
  startedAt?: string;
  endedAt?: string;
  accessibility?: boolean;
  inputMonitoring?: boolean;
  permissionCheckedAt?: string;
}

export async function recorderStatus(options: { installedBinary?: string } = {}): Promise<RecorderRuntimeStatus> {
  const home = historyHome();
  let parsed: RecorderRuntimeStatus;
  try {
    parsed = JSON.parse(
      await readFile(join(home, "runtime.json"), "utf8"),
    ) as RecorderRuntimeStatus;
  } catch {
    return stoppedStatus(home);
  }
  if (!parsed || !["stopped", "running", "paused"].includes(parsed.state)) return stoppedStatus(home);
  if (parsed.state === "stopped") return parsed;
  if (!Number.isSafeInteger(parsed.processIdentifier) || (parsed.processIdentifier ?? 0) <= 0) {
    return stoppedStatus(home, parsed.endedAt);
  }
  const binary = options.installedBinary ?? installedCollectorBinary();
  if (binary) {
    const native = await nativeStatus(binary);
    return native.state === parsed.state && native.processIdentifier === parsed.processIdentifier
      ? parsed : stoppedStatus(home, parsed.endedAt);
  }
  return await isCollectorProcessAlive(parsed.processIdentifier!) ? parsed : stoppedStatus(home, parsed.endedAt);
}

export async function pauseRecorder(): Promise<RecorderRuntimeStatus> {
  if (installedCollectorBinary()) return nativeControl("pause", "paused");
  const status = await recorderStatus();
  if (status.state === "stopped") {
    throw new Error("Computer History is stopped.");
  }
  await writeControl("paused");
  return waitForState("paused");
}

export async function resumeRecorder(): Promise<RecorderRuntimeStatus> {
  if (installedCollectorBinary()) return nativeControl("resume", "running");
  const status = await recorderStatus();
  if (status.state === "stopped") {
    const binary = await collectorBinary();
    await writeControl("running");
    const log = await open(join(historyHome(), "collector.stderr.log"), "w", 0o600);
    let startupError: Error | undefined;
    const child = spawn(binary, ["record", "--no-prompt"], {
      detached: true,
      env: {
        ...process.env,
        OPEN_COMPUTER_HISTORY_HOME: historyHome(),
      },
      stdio: ["ignore", "ignore", log.fd],
    });
    child.once("error", (error) => { startupError = error; });
    child.unref();
    await log.close();
    return waitForState("running", async () => {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = await readFile(join(historyHome(), "collector.stderr.log"), "utf8");
        throw new Error(`Collector exited (${child.exitCode ?? child.signalCode}): ${detail}`);
      }
    });
  }
  await writeControl("running");
  return waitForState("running");
}

export async function stopRecorder(): Promise<RecorderRuntimeStatus> {
  if (installedCollectorBinary()) return nativeControl("stop", "stopped");
  const status = await recorderStatus();
  if (status.state === "stopped" || !status.processIdentifier) return status;
  process.kill(status.processIdentifier, "SIGTERM");
  return waitForState("stopped");
}

function installedCollectorBinary(): string | null {
  const agent = process.env.OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT;
  if (!agent) return null;
  const binary = process.env.OPEN_HISTORY_COLLECTOR_BIN;
  if (!binary) throw new Error(`OPEN_HISTORY_COLLECTOR_BIN is required with OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT=${agent}`);
  return binary;
}

async function nativeStatus(binary: string): Promise<{ state: RecorderState; processIdentifier?: number }> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(binary, ["status"], { timeout: 5000 }));
  } catch (error) {
    throw new Error(`Collector status failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    const parsed = JSON.parse(stdout) as { state: RecorderState; processIdentifier?: number };
    if (!["stopped", "running", "paused"].includes(parsed.state)) throw new Error(`invalid state ${String(parsed.state)}`);
    return parsed;
  } catch (error) {
    throw new Error(`Collector status returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function nativeControl(command: "pause" | "resume" | "stop", expected: RecorderState): Promise<RecorderRuntimeStatus> {
  const binary = installedCollectorBinary()!;
  try {
    await promisify(execFile)(binary, [command], { timeout: 15_000 });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Collector ${command} failed: ${cause}${detail && !cause.includes(detail) ? `\n${detail}` : ""}`, { cause: error });
  }
  const status = await recorderStatus();
  if (status.state !== expected) {
    throw new Error(`Collector ${command} returned successfully but runtime state is ${status.state}, expected ${expected}.`);
  }
  return status;
}

export async function eventStreamStatus() {
  const status = await recorderStatus();
  let sessionID: string | undefined;
  if (status.currentSegmentMetadataPath) {
    try {
      const metadata = JSON.parse(
        await readFile(status.currentSegmentMetadataPath, "utf8"),
      ) as { id?: string };
      sessionID = metadata.id;
    } catch {
      // The status remains useful while metadata is temporarily unavailable.
    }
  }
  return {
    isRecording: status.state === "running",
    ...(sessionID ? { sessionID } : {}),
    ...(status.currentSegmentEventsPath
      ? {
          sessionDirectoryPath: dirname(status.currentSegmentEventsPath),
          eventsPath: status.currentSegmentEventsPath,
        }
      : {}),
    ...(status.currentSegmentMetadataPath
      ? { metadataPath: status.currentSegmentMetadataPath }
      : {}),
    ...(status.suppressedEventsPath
      ? { suppressedEventsPath: status.suppressedEventsPath }
      : {}),
    ...(status.startedAt ? { startedAt: status.startedAt } : {}),
    ...(status.endedAt ? { endedAt: status.endedAt } : {}),
    maxDurationSeconds: 1800,
  };
}

async function writeControl(
  state: RecorderState,
  resumeAt?: Date,
): Promise<void> {
  const path = join(historyHome(), "control.json");
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(historyHome(), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        state,
        // Swift JSONDecoder's .iso8601 strategy rejects fractional seconds.
        updatedAt: controlTimestamp(new Date()),
        ...(resumeAt ? { resumeAt: controlTimestamp(resumeAt) } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await rename(temporaryPath, path);
}

function controlTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function waitForState(expected: RecorderState, checkStartup?: () => Promise<void>): Promise<RecorderRuntimeStatus> {
  const deadline = Date.now() + 8_000;
  let latest = await recorderStatus();
  while (Date.now() < deadline) {
    await checkStartup?.();
    latest = await recorderStatus();
    if (latest.state === expected) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `Computer History did not reach ${expected}; current state is ${latest.state}.`,
  );
}

async function collectorBinary(): Promise<string> {
  const candidates = [
    process.env.OPEN_HISTORY_COLLECTOR_BIN,
    resolve("collector/.build/release/open-history"),
    resolve("collector/.build/debug/open-history"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known build location.
    }
  }
  throw new Error(
    "The open-history collector is not built. Run `npm run collector:build`.",
  );
}

async function isCollectorProcessAlive(processIdentifier: number): Promise<boolean> {
  try {
    process.kill(processIdentifier, 0);
    const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(processIdentifier), "-o", "comm="], { timeout: 1500 });
    return basename(stdout.trim()) === basename(process.env.OPEN_HISTORY_COLLECTOR_BIN ?? "open-history");
  } catch {
    return false;
  }
}

function stoppedStatus(
  home: string,
  endedAt?: string,
): RecorderRuntimeStatus {
  return {
    state: "stopped",
    eventStreamRootPath: home,
    ...(endedAt ? { endedAt } : {}),
  };
}
