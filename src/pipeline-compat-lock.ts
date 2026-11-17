import { execFile } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { historyHome } from "./history-store.js";

const execFileAsync = promisify(execFile);
const incompleteLockGraceMilliseconds = 10_000;

export async function acquireLegacyPipelineLock(
  path = join(historyHome(), "pipeline.lock"),
): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      if (await legacyLockMightBeActive(path)) return null;
      await rm(path, { force: true });
      continue;
    }
    await handle.writeFile(`${process.pid}\n`);
    return async () => {
      let owned = false;
      try {
        owned = (await readFile(path, "utf8")).trim() === String(process.pid);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      await handle.close();
      if (owned) await rm(path, { force: true });
    };
  }
  return null;
}

async function legacyLockMightBeActive(path: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }

  const pid = Number(contents.trim());
  if (Number.isSafeInteger(pid) && pid > 0) {
    return await legacyPipelineIsAlive(pid);
  }

  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs < incompleteLockGraceMilliseconds;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function legacyPipelineIsAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", "command="],
      { encoding: "utf8", timeout: 1_500 },
    );
    return /(?:^|\/)pipeline\.(?:mjs|ts)(?:\s|$)/.test(stdout) &&
      /(?:^|\s)(?:locked-)?run(?:\s|$)/.test(stdout);
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
  }
}
