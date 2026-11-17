import { runLockedProcess } from "../../src/pipeline-lock.ts";

const [lockPath, runnerPIDPath, executable, ...args] = process.argv.slice(2);
if (!lockPath || !runnerPIDPath || !executable) {
  throw new Error("Usage: run-locked-process lock runner-pid executable [args...]");
}

process.exitCode = await runLockedProcess({
  lockPath,
  runnerPIDPath,
  executable,
  args,
});
