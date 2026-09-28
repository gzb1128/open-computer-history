import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { resumeRecorder } from "../src/runtime-control.ts";

const native = process.env.OPEN_HISTORY_NATIVE_BIN;

test("Swift decodes legacy and current Node control timestamps", { skip: !native && "Set OPEN_HISTORY_NATIVE_BIN or run npm run test:contract" }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "history-control-contract-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [name, updatedAt, resumeAt] of [
    ["whole ISO", "2026-09-28T01:02:03Z", "2026-09-28T02:03:04Z"],
    ["fractional ISO", "2026-09-28T01:02:03.123Z", "2026-09-28T02:03:04.567Z"],
  ] as const) {
    const path = join(home, `${name.replaceAll(" ", "-")}.json`);
    await writeFile(path, JSON.stringify({ state: "paused", updatedAt, resumeAt }));
    const { stdout } = await promisify(execFile)(native!, ["contract-probe", path]);
    const decoded = JSON.parse(stdout) as { state: string; updatedAt: string; resumeAt: string };
    assert.equal(decoded.state, "paused", name);
    assert.equal(decoded.updatedAt, "2026-09-28T01:02:03Z", name);
    assert.equal(decoded.resumeAt, "2026-09-28T02:03:04Z", name);
  }

  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  delete process.env.OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT;
  const fail = join(home, "fail-collector");
  await writeFile(fail, "#!/bin/sh\nexit 2\n");
  await chmod(fail, 0o700);
  process.env.OPEN_HISTORY_COLLECTOR_BIN = fail;
  await assert.rejects(resumeRecorder());
  const { stdout } = await promisify(execFile)(native!, ["contract-probe", join(home, "control.json")]);
  assert.equal((JSON.parse(stdout) as { state: string }).state, "running", "native decodes the actual Node control writer");
});

test("native collector lock rejects a second process", { skip: !native && "Set OPEN_HISTORY_NATIVE_BIN or run npm run test:contract" }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "history-lock-contract-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = spawn(native!, ["contract-probe", "--lock", home, "--hold", "3"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { first.kill("SIGTERM"); });
  const ready = await Promise.race([
    new Promise<string>((resolvePromise) => first.stdout.once("data", (data) => resolvePromise(String(data)))),
    new Promise<never>((_resolvePromise, reject) => setTimeout(() => reject(new Error("native lock probe did not start")), 2000)),
  ]);
  assert.match(ready, /locked/);
  await assert.rejects(promisify(execFile)(native!, ["contract-probe", "--lock", home, "--hold", "0"]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(String((error as Error & { stderr?: string }).stderr), /already running/);
    return true;
  });
});
