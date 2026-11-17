import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { acquireLegacyPipelineLock } from "../src/pipeline-compat-lock.ts";
import { startLockedProcess } from "../src/pipeline-lock.ts";
import { previousCompletedBucket } from "../src/pipeline.ts";

test("10-minute buckets align to UTC boundaries", () => {
  const bucket = previousCompletedBucket(
    new Date("2026-08-14T17:37:42Z"),
    10 * 60 * 1000,
  );
  assert.equal(bucket.start.toISOString(), "2026-08-14T17:20:00.000Z");
  assert.equal(bucket.end.toISOString(), "2026-08-14T17:30:00.000Z");
});

test("6-hour buckets align to UTC boundaries", () => {
  const bucket = previousCompletedBucket(
    new Date("2026-08-14T17:37:42Z"),
    6 * 60 * 60 * 1000,
  );
  assert.equal(bucket.start.toISOString(), "2026-08-14T06:00:00.000Z");
  assert.equal(bucket.end.toISOString(), "2026-08-14T12:00:00.000Z");
});

test("kernel lock ignores stale PID contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "pipeline.lock");
  await writeFile(lock, `${process.pid}\n`);

  const child = startLockedProcess({
    lockPath: lock,
    executable: "/usr/bin/true",
    args: [],
    stdio: "ignore",
  });
  assert.equal(await exitCode(child), 0);
  assert.equal(await readFile(lock, "utf8"), `${process.pid}\n`);
});

test("compatibility lock recovers from a dead legacy PID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-legacy-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "pipeline.lock");
  await writeFile(lock, "99999999\n");

  const release = await acquireLegacyPipelineLock(lock);
  assert.notEqual(release, null);
  assert.equal(await readFile(lock, "utf8"), `${process.pid}\n`);
  await release!();
  await assert.rejects(readFile(lock, "utf8"), { code: "ENOENT" });
});

test("compatibility release leaves a replacement owner untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "pipeline.lock");

  const release = await acquireLegacyPipelineLock(lock);
  assert.notEqual(release, null);
  await writeFile(lock, "12345\n");
  await release!();
  assert.equal(await readFile(lock, "utf8"), "12345\n");
});

test("concurrent pipeline starters produce exactly one lock owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-active-"));
  const lock = join(root, "pipeline.lock");
  await writeFile(lock, "99999999\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const children = Array.from({ length: 16 }, () =>
    startLockedProcess({
      lockPath: lock,
      executable: "/bin/sh",
      args: ["-c", "sleep 0.5"],
      stdio: "ignore",
    }),
  );
  for (const child of children) {
    t.after(() => stopProcessGroupAndWait(child));
  }
  const codes = await Promise.all(children.map(exitCode));
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(codes.filter((code) => code === 75).length, 15);
});

test("pipeline entrypoint exits cleanly when another runner owns the lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-entry-"));
  const history = join(root, "history");
  const lock = join(history, "pipeline.kernel.lock");
  const entrypoint = resolve("scripts/pipeline.ts");
  const environment = {
    ...process.env,
    OPEN_COMPUTER_HISTORY_HOME: history,
  };
  const first = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    { detached: true, env: environment, stdio: "ignore" },
  );
  t.after(async () => {
    await stopProcessGroupAndWait(first);
    await rm(root, { recursive: true, force: true });
  });

  await new Promise((done) => setTimeout(done, 750));
  assert.match(await readFile(join(history, "pipeline.lock"), "utf8"), /^\d+\n$/);
  const second = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  second.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  assert.equal(await exitCode(second), 0);
  assert.match(stderr, /pipeline is already running/);

  assert.equal(first.exitCode, null);
  process.kill(-first.pid!, "SIGHUP");
  await exitCode(first);
  await waitForFileRemoval(join(history, "pipeline.lock"));
  const probe = startLockedProcess({
    lockPath: lock,
    executable: "/usr/bin/true",
    args: [],
    stdio: "ignore",
  });
  assert.equal(await exitCode(probe), 0);
});

test("new runtime defers to a live legacy pipeline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-legacy-"));
  const history = join(root, "history");
  const legacyLock = join(history, "pipeline.lock");
  const legacyScript = join(root, "pipeline.mjs");
  const entrypoint = resolve("scripts/pipeline.ts");
  await writeFile(legacyScript, "setInterval(() => {}, 1000);\n");
  await mkdir(history, { recursive: true });
  const legacy = spawn(
    process.execPath,
    [legacyScript, "locked-run"],
    { detached: true, stdio: "ignore" },
  );
  t.after(async () => {
    await stopProcessGroupAndWait(legacy);
    await rm(root, { recursive: true, force: true });
  });
  await once(legacy, "spawn");
  await writeFile(legacyLock, `${legacy.pid}\n`);

  const current = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    {
      env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: history },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  current.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  assert.equal(await exitCode(current), 0);
  assert.match(stderr, /pipeline is already running/);
  assert.equal(legacy.exitCode, null);
});

test("orphaned locked-run blocks successors until its parent is gone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-orphan-"));
  const history = join(root, "history");
  const entrypoint = resolve("scripts/pipeline.ts");
  const environment = {
    ...process.env,
    OPEN_COMPUTER_HISTORY_HOME: history,
  };
  const first = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    { detached: true, env: environment, stdio: "ignore" },
  );
  let lockedRunPID: number | null = null;
  t.after(async () => {
    await stopProcessGroupAndWait(first);
    if (lockedRunPID !== null) stopPID(lockedRunPID, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  const lockfPID = await waitForLockfChild(first.pid!);
  lockedRunPID = await waitForPIDFile(join(history, "pipeline.lock"));
  process.kill(lockfPID, "SIGKILL");
  await exitCode(first);

  const contender = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  contender.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  assert.equal(await exitCode(contender), 0);
  assert.match(stderr, /pipeline is already running/);
  await waitForProcessExit(lockedRunPID);
  await waitForFileRemoval(join(history, "pipeline.lock"));
});

test("outer wrapper death clears its runner and allows supervised restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-wrapper-"));
  const history = join(root, "history");
  const entrypoint = resolve("scripts/pipeline.ts");
  const environment = {
    ...process.env,
    OPEN_COMPUTER_HISTORY_HOME: history,
  };
  const first = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    { detached: true, env: environment, stdio: "ignore" },
  );
  let lockedRunPID: number | null = null;
  let successor: ChildProcess | null = null;
  t.after(async () => {
    await stopProcessGroupAndWait(first);
    if (successor !== null) await stopProcessGroupAndWait(successor);
    if (lockedRunPID !== null) stopPID(lockedRunPID, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  const lockfPID = await waitForLockfChild(first.pid!);
  lockedRunPID = await waitForPIDFile(join(history, "pipeline.lock"));
  process.kill(first.pid!, "SIGKILL");
  await exitCode(first);
  await waitForProcessExit(lockedRunPID);
  await waitForProcessExit(lockfPID);
  await waitForFileRemoval(join(history, "pipeline.lock"));

  successor = spawn(
    process.execPath,
    ["--import", "tsx", entrypoint, "run"],
    { detached: true, env: environment, stdio: "ignore" },
  );
  const restartedPID = await waitForPIDFile(join(history, "pipeline.lock"));
  assert.doesNotThrow(() => process.kill(restartedPID, 0));
});

test("wrapper releases both locks for direct termination signals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-signals-"));
  const history = join(root, "history");
  const kernelLock = join(history, "pipeline.kernel.lock");
  const compatibilityLock = join(history, "pipeline.lock");
  const runnerPID = join(history, "pipeline.runner.pid");
  const entrypoint = resolve("scripts/pipeline.ts");
  const environment = {
    ...process.env,
    OPEN_COMPUTER_HISTORY_HOME: history,
  };
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const signal of ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"] as const) {
    const wrapper = spawn(
      process.execPath,
      ["--import", "tsx", entrypoint, "run"],
      { detached: true, env: environment, stdio: "ignore" },
    );
    t.after(() => stopProcessGroupAndWait(wrapper));
    await waitForPIDFile(runnerPID);
    process.kill(wrapper.pid!, signal);
    assert.equal(await waitForChildExit(wrapper, 3_000), true, signal);
    await waitForFileRemoval(compatibilityLock);
    const probe = startLockedProcess({
      lockPath: kernelLock,
      executable: "/usr/bin/true",
      args: [],
      stdio: "ignore",
    });
    assert.equal(await exitCode(probe), 0, signal);
  }
});

test("wrapper signal forwarding ignores a foreign compatibility PID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-history-pipeline-identity-"));
  const lock = join(root, "pipeline.kernel.lock");
  const runnerPID = join(root, "pipeline.runner.pid");
  const helper = resolve("test/fixtures/run-locked-process.ts");
  const foreign = spawn("/bin/sleep", ["10"], { detached: true, stdio: "ignore" });
  await writeFile(runnerPID, `${foreign.pid}\n`);
  const wrapper = spawn(
    process.execPath,
    ["--import", "tsx", helper, lock, runnerPID, "/bin/sleep", "10"],
    { detached: true, stdio: "ignore" },
  );
  t.after(async () => {
    await stopProcessGroupAndWait(wrapper);
    await stopProcessGroupAndWait(foreign);
    await rm(root, { recursive: true, force: true });
  });

  await waitForLockfChild(wrapper.pid!);
  process.kill(wrapper.pid!, "SIGTERM");
  assert.equal(await waitForChildExit(wrapper, 3_000), true);
  assert.doesNotThrow(() => process.kill(foreign.pid!, 0));
});

async function exitCode(child: ChildProcess): Promise<number | null> {
  const [code] = await once(child, "exit");
  return code;
}

function stopProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited between the state check and signal.
    }
  }
}

async function stopProcessGroupAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  stopProcessGroup(child);
  if (await waitForChildExit(child, 2_000)) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  if (!(await waitForChildExit(child, 2_000))) {
    throw new Error(`Process ${child.pid ?? "unknown"} did not exit`);
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolvePromise) => {
    const done = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMilliseconds);
    child.once("exit", onExit);
  });
}

async function waitForFileRemoval(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for ${path} to be removed`);
}

async function waitForLockfChild(parentPID: number): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const processes = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    });
    for (const line of processes.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match && Number(match[2]) === parentPID && match[3].includes("/usr/bin/lockf")) {
        return Number(match[1]);
      }
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for lockf child of ${parentPID}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function waitForPIDFile(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for a PID in ${path}`);
}

function stopPID(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited already.
  }
}
