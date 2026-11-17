import {
  spawn,
  spawnSync,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

interface LockedProcessOptions {
  lockPath: string;
  executable: string;
  args: string[];
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
  runnerPIDPath: string;
}

export function startLockedProcess({
  lockPath,
  executable,
  args,
  stdio = "inherit",
  env,
}: LockedProcessOptions): ChildProcess {
  mkdirSync(dirname(lockPath), { recursive: true });
  return spawn(
    "/usr/bin/lockf",
    ["-k", "-s", "-t", "0", lockPath, executable, ...args],
    { stdio, env },
  );
}

export async function runLockedProcess(
  options: LockedProcessOptions,
): Promise<number> {
  const child = startLockedProcess({
    ...options,
    env: {
      ...process.env,
      ...options.env,
      OPEN_HISTORY_PIPELINE_OWNER_PID: String(process.pid),
      OPEN_HISTORY_PIPELINE_RUNNER_PID_FILE: options.runnerPIDPath,
    },
  });
  const forward = (signal: NodeJS.Signals) => {
    const targetPID = ownedRunnerPID(child.pid, options.runnerPIDPath);
    if (targetPID !== null) {
      try {
        process.kill(targetPID, signal);
      } catch {
        // The runner may already be exiting.
      }
    }
    try {
      child.kill(signal === "SIGINT" || signal === "SIGQUIT" ? "SIGTERM" : signal);
    } catch {
      // The locked process may already be exiting.
    }
  };
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTermination = () => forward("SIGTERM");
  const forwardHangup = () => forward("SIGHUP");
  const forwardQuit = () => forward("SIGQUIT");
  process.once("SIGHUP", forwardHangup);
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  process.once("SIGQUIT", forwardQuit);

  const [code, signal] = await once(child, "exit");
  process.off("SIGHUP", forwardHangup);
  process.off("SIGINT", forwardInterrupt);
  process.off("SIGTERM", forwardTermination);
  process.off("SIGQUIT", forwardQuit);
  return code ?? (signal ? 128 + signalNumber(signal) : 1);
}

function ownedRunnerPID(
  lockfPID: number | undefined,
  runnerPIDPath: string,
): number | null {
  if (lockfPID === undefined) return null;
  let runnerPID: number;
  try {
    runnerPID = Number(readFileSync(runnerPIDPath, "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(runnerPID) || runnerPID <= 0) return null;
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(runnerPID), "-o", "ppid=,command="],
    { encoding: "utf8", timeout: 1_500 },
  );
  const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout);
  return result.status === 0 &&
    Number(match?.[1]) === lockfPID &&
    /(?:^|\/)pipeline\.(?:mjs|ts)(?:\s|$)/.test(match?.[2] ?? "") &&
    /(?:^|\s)locked-run(?:\s|$)/.test(match?.[2] ?? "")
    ? runnerPID
    : null;
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1;
}
