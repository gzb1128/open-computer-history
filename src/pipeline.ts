import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { historyHome } from "./history-store.js";
import { summarizeInterval } from "./summarizer.js";

type SummaryLevel = "10min" | "6h";

interface PipelineBucketResult {
  level: SummaryLevel;
  start: string;
  end: string;
  status: "completed" | "empty";
  memoryPath?: string;
}

interface PipelineState {
  version: 1;
  buckets: Record<string, PipelineBucketResult>;
}

const tenMinutes = 10 * 60 * 1000;
const sixHours = 6 * 60 * 60 * 1000;

export async function runPipelineTick(
  now = new Date(),
): Promise<PipelineBucketResult[]> {
  const state = await readState();
  const results: PipelineBucketResult[] = [];

  for (const [level, duration] of [
    ["10min", tenMinutes],
    ["6h", sixHours],
  ] as const) {
    const bucket = previousCompletedBucket(now, duration);
    const key = bucketKey(level, bucket.start);
    if (state.buckets[key]) continue;

    let result: PipelineBucketResult;
    try {
      const summary = await summarizeInterval({
        start: bucket.start,
        end: bucket.end,
        level,
      });
      result = {
        level,
        start: bucket.start.toISOString(),
        end: bucket.end.toISOString(),
        status: "completed",
        memoryPath: summary.memoryPath,
      };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("No ")) {
        throw error;
      }
      result = {
        level,
        start: bucket.start.toISOString(),
        end: bucket.end.toISOString(),
        status: "empty",
      };
    }
    state.buckets[key] = result;
    results.push(result);
    await writeState(state);
  }
  return results;
}

export async function runPipelineLoop(
  onShutdown?: () => Promise<void>,
): Promise<never> {
  let stopping = false;
  const parentPID = process.ppid;
  const serviceOwnerPID = Number(process.env.OPEN_HISTORY_PIPELINE_OWNER_PID);
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void (onShutdown?.() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGHUP", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGQUIT", shutdown);
  const parentWatch = setInterval(() => {
    if (
      process.ppid !== parentPID ||
      (Number.isSafeInteger(serviceOwnerPID) &&
        serviceOwnerPID > 0 &&
        !processIsAlive(serviceOwnerPID))
    ) {
      shutdown();
    }
  }, 1_000);
  parentWatch.unref();

  while (true) {
    try {
      await runPipelineTick();
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : String(error),
      );
    }
    await delay(60_000);
  }
}

export function previousCompletedBucket(now: Date, durationMs: number) {
  const endMs = Math.floor(now.getTime() / durationMs) * durationMs;
  return {
    start: new Date(endMs - durationMs),
    end: new Date(endMs),
  };
}

async function readState(): Promise<PipelineState> {
  try {
    const parsed = JSON.parse(
      await readFile(join(historyHome(), "pipeline-state.json"), "utf8"),
    ) as PipelineState;
    if (parsed.version === 1 && parsed.buckets) return parsed;
  } catch {
    // Start with an empty pipeline state.
  }
  return { version: 1, buckets: {} };
}

async function writeState(state: PipelineState): Promise<void> {
  const path = join(historyHome(), "pipeline-state.json");
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(historyHome(), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function bucketKey(level: SummaryLevel, start: Date): string {
  return `${level}:${start.toISOString()}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
