import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pauseRecorder, recorderStatus, resumeRecorder, stopRecorder } from "../src/runtime-control.ts";

test("resume reports collector startup failures instead of a state timeout", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "history-startup-"));
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(home, { recursive: true, force: true });
  });
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  delete process.env.OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT;
  const binary = join(home, "collector");
  process.env.OPEN_HISTORY_COLLECTOR_BIN = binary;
  await writeFile(binary, '#!/bin/sh\necho "Accessibility permission required" >&2\nexit 2\n');
  await chmod(binary, 0o700);
  await assert.rejects(resumeRecorder(), /Collector exited \(2\): Accessibility permission required/);
  const control = JSON.parse(await readFile(join(home, "control.json"), "utf8"));
  assert.equal(control.state, "running");
  assert.match(control.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    "control timestamps must be accepted by Swift JSONDecoder.iso8601");

  await chmod(binary, 0o600);
  await assert.rejects(resumeRecorder(), /EACCES/);
});

test("malformed runtime state and PID cannot claim a live recorder", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "history-status-validate-"));
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(home, { recursive: true, force: true });
  });
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  await writeFile(join(home, "runtime.json"), JSON.stringify({ state: "recording", processIdentifier: process.pid }));
  assert.equal((await recorderStatus()).state, "stopped");
  await writeFile(join(home, "runtime.json"), JSON.stringify({ state: "running", processIdentifier: -1 }));
  assert.equal((await recorderStatus()).state, "stopped");
  delete process.env.OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT;
  delete process.env.OPEN_HISTORY_COLLECTOR_BIN;
  await writeFile(join(home, "runtime.json"), JSON.stringify({ state: "running", processIdentifier: process.pid }));
  assert.equal((await recorderStatus()).state, "stopped", "a reused PID from another executable is not a collector");
  assert.equal((await stopRecorder()).state, "stopped", "developer Stop must not signal an unrelated process");
});

test("installed control delegates each transition to the native collector CLI", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "history-native-control-"));
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(home, { recursive: true, force: true });
  });
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  process.env.OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT = "dev.opencomputerhistory.collector";
  const binary = join(home, "native-control");
  process.env.OPEN_HISTORY_COLLECTOR_BIN = binary;
  process.env.OPEN_HISTORY_TEST_PID = String(process.pid);
  await writeFile(binary, `#!/bin/sh
printf '%s\\n' "$1" >> "$OPEN_COMPUTER_HISTORY_HOME/invocations"
case "$1" in
  status) cat "$OPEN_COMPUTER_HISTORY_HOME/runtime.json"; exit 0 ;;
  resume) state=running ;;
  pause) state=paused ;;
  stop) state=stopped ;;
esac
printf '{"state":"%s","processIdentifier":%s,"eventStreamRootPath":"%s"}\\n' "$state" "$OPEN_HISTORY_TEST_PID" "$OPEN_COMPUTER_HISTORY_HOME" > "$OPEN_COMPUTER_HISTORY_HOME/runtime.json"
`);
  await chmod(binary, 0o700);
  assert.equal((await resumeRecorder()).state, "running");
  assert.equal((await pauseRecorder()).state, "paused");
  assert.equal((await stopRecorder()).state, "stopped");
  assert.deepEqual((await readFile(join(home, "invocations"), "utf8")).trim().split("\n"), ["resume", "status", "pause", "status", "stop"]);
  await assert.rejects(readFile(join(home, "control.json")), { code: "ENOENT" }, "Node does not run a second installed lifecycle");
});

test("native failure preserves the cause and never falls back to a detached recorder", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "history-native-error-"));
  const previous = { ...process.env };
  t.after(async () => {
    process.env = previous;
    await rm(home, { recursive: true, force: true });
  });
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  process.env.OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT = "dev.opencomputerhistory.collector";
  const binary = join(home, "native-control");
  process.env.OPEN_HISTORY_COLLECTOR_BIN = binary;
  await writeFile(binary, '#!/bin/sh\necho "permission denied by collector" >&2\nexit 3\n');
  await chmod(binary, 0o700);
  await assert.rejects(resumeRecorder(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /permission denied by collector/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  await assert.rejects(readFile(join(home, "control.json")), { code: "ENOENT" });
});
