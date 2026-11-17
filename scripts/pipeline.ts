import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rm, writeFile } from "node:fs/promises";
import { historyHome } from "../src/history-store.js";
import { acquireLegacyPipelineLock } from "../src/pipeline-compat-lock.js";
import { runLockedProcess } from "../src/pipeline-lock.js";
import { runPipelineLoop, runPipelineTick } from "../src/pipeline.js";

const command = process.argv[2] ?? "once";
if (command === "once") {
  console.log(JSON.stringify(await runPipelineTick(), null, 2));
} else if (command === "run") {
  const history = historyHome();
  const runnerPIDPath = join(history, "pipeline.runner.pid");
  const code = await runLockedProcess({
    lockPath: join(history, "pipeline.kernel.lock"),
    runnerPIDPath,
    executable: process.execPath,
    args: [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      "locked-run",
    ],
  });
  const alreadyRunning = code === 75;
  if (alreadyRunning) {
    console.error("Computer History pipeline is already running.");
  }
  process.exitCode = alreadyRunning ? 0 : code;
} else if (command === "locked-run") {
  const releaseLegacyLock = await acquireLegacyPipelineLock();
  if (!releaseLegacyLock) {
    console.error("Computer History pipeline is already running.");
    process.exitCode = 0;
  } else {
    const runnerPIDPath = process.env.OPEN_HISTORY_PIPELINE_RUNNER_PID_FILE;
    if (!runnerPIDPath) {
      await releaseLegacyLock();
      throw new Error("OPEN_HISTORY_PIPELINE_RUNNER_PID_FILE is required");
    }
    try {
      await writeFile(runnerPIDPath, `${process.pid}\n`, { mode: 0o600 });
    } catch (error) {
      await releaseLegacyLock();
      throw error;
    }
    await runPipelineLoop(async () => {
      try {
        if ((await readFile(runnerPIDPath, "utf8")).trim() === String(process.pid)) {
          await rm(runnerPIDPath, { force: true });
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      await releaseLegacyLock();
    });
  }
} else {
  console.error("Usage: pipeline.ts once|run");
  process.exit(2);
}
