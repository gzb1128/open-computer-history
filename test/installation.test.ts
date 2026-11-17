import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { defaultMCPPort, labels } from "../scripts/local-service-manifest.mjs";

const execFileAsync = promisify(execFile);
const installer = resolve("scripts/local-install.mjs");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open history install "));
  const home = join(root, "home <&> with spaces");
  const bundle = join(root, "bundle <&>");
  const launchctl = join(root, "fake-launchctl");
  const loaded = join(root, "loaded");
  await mkdir(home, { recursive: true });
  await mkdir(loaded);
  for (const name of [
    "Open Computer History.app/Contents/Info.plist",
    "Open Computer History.app/Contents/MacOS/Open Computer History",
    "Open Computer History.app/Contents/MacOS/open-history",
    "runtime/package.json",
    "runtime/.mcp-use/build/index.js",
    "runtime/.mcp-use/build/manifest.json",
    "runtime/node_modules/@mcp-use/cli/dist/bin.js",
    "runtime/bin/native-ipc.mjs",
    "runtime/bin/pipeline.mjs",
    "runtime/bin/doctor.mjs",
  ]) {
    const file = join(bundle, name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, name.endsWith("package.json") ? "{}\n" : name.endsWith("manifest.json") ? '{"views":{}}\n' : "#!/bin/sh\nexit 0\n");
    if (name.includes("/MacOS/")) await chmod(file, 0o755);
  }
  await writeFile(launchctl, `#!/bin/sh
set -eu
label=\${3##*/}
label=\${label%.plist}
if [ "$1" = print ]; then
  label=\${2##*/}
  test -f "$FAKE_LAUNCH_DIR/$label"
elif [ "$1" = bootout ]; then
  rm -f "$FAKE_LAUNCH_DIR/$label"
elif [ "$1" = bootstrap ]; then
  if [ "\${FAKE_FAIL_LABEL:-}" = "$label" ]; then exit 5; fi
  touch "$FAKE_LAUNCH_DIR/$label"
elif [ "$1" = kickstart ]; then
  label=\${2##*/}
fi
printf '%s|%s\n' "$1" "$label" >>"$FAKE_LAUNCH_DIR/operations"
`);
  await chmod(launchctl, 0o755);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    OPEN_HISTORY_INSTALL_LAUNCHCTL: launchctl,
    FAKE_LAUNCH_DIR: loaded,
  };
  const run = async (command: string, args: string[] = [], moreEnv: Record<string, string> = {}) =>
    execFileAsync(process.execPath, [installer, command, "--home", home, ...(command === "uninstall" ? [] : ["--from-bundle", bundle]), ...args], {
      env: { ...env, ...moreEnv }, timeout: 15_000,
    });
  return { root, home, bundle, loaded, run };
}

test("plan is read-only and XML escapes paths; fresh collector waits for explicit start", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const { stdout } = await f.run("plan", ["--with-ipc"]);
  const plan = JSON.parse(stdout);
  const shellPlan = JSON.parse((await execFileAsync(resolve("scripts/install-local.sh"), [
    "--plan", "--home", f.home, "--with-ipc",
  ])).stdout);
  assert.equal(shellPlan.app, plan.app);
  assert.deepEqual(shellPlan.selection, plan.selection);
  assert.equal(plan.endpoint, `http://127.0.0.1:${defaultMCPPort}/mcp`);
  assert.equal(plan.selection.startCollector, false);
  assert.deepEqual(plan.services.map((service: { label: string }) => service.label), [
    labels.menu, labels.collector, labels.mcp, labels.ipc,
  ]);
  assert.equal((await readdir(f.loaded)).length, 0);
  await f.run("install", ["--with-ipc"]);
  const collector = await readFile(join(f.home, "Library/LaunchAgents", `${labels.collector}.plist`), "utf8");
  const menu = await readFile(join(f.home, "Library/LaunchAgents", `${labels.menu}.plist`), "utf8");
  const mcp = await readFile(join(f.home, "Library/LaunchAgents", `${labels.mcp}.plist`), "utf8");
  assert.match(collector, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(collector, /<key>KeepAlive<\/key><false\/>/);
  assert.match(collector, /collector\.stderr\.log/);
  assert.match(menu, /home &lt;&amp;&gt; with spaces/);
  assert.match(menu, /OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT/);
  assert.match(menu, /<key>KeepAlive<\/key><false\/>/);
  assert.match(mcp, /<string>3317<\/string>/);
  assert.match(mcp, /node_modules\/@mcp-use\/cli\/dist\/bin\.js/);
  await execFileAsync("/usr/bin/plutil", ["-lint", join(f.home, "Library/LaunchAgents", `${labels.menu}.plist`)]);
});

test("repeat install preserves optional services and data; explicit disable removes them", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const historyFile = join(f.home, ".open-codex-computer-history", "config.json");
  await mkdir(join(historyFile, ".."), { recursive: true });
  await writeFile(historyFile, '{"captureText":false}\n');
  await f.run("install", ["--with-ipc", "--with-summaries", "--start-collector"]);
  assert.match(
    await readFile(join(f.home, "Library/LaunchAgents", `${labels.pipeline}.plist`), "utf8"),
    /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/,
  );
  const plan = JSON.parse((await f.run("plan")).stdout);
  assert.deepEqual(plan.selection, { ipc: true, summaries: true, startCollector: true });
  assert.equal(plan.preserved.ipc, true);
  assert.equal(plan.preserved.summaries, true);
  await f.run("install");
  assert.equal((await readdir(f.loaded)).filter((name) => name !== "operations").length, 5);
  await f.run("install", ["--without-ipc", "--without-summaries", "--no-start-collector"]);
  assert.deepEqual((await readdir(f.loaded)).filter((name) => name !== "operations").sort(), [
    labels.collector, labels.mcp, labels.menu,
  ].sort());
  assert.equal(await readFile(historyFile, "utf8"), '{"captureText":false}\n');
  await f.run("uninstall");
  assert.equal(await readFile(historyFile, "utf8"), '{"captureText":false}\n');
  assert.deepEqual((await readdir(f.loaded)).filter((name) => name !== "operations"), []);
});

test("service profiles make the LaunchAgent set explicit", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  const core = JSON.parse((await f.run("plan", ["--profile", "core"])).stdout);
  assert.deepEqual(core.selection, {
    ipc: false,
    summaries: false,
    startCollector: false,
  });
  assert.deepEqual(core.services.map((service: { label: string }) => service.label), [
    labels.menu, labels.collector, labels.mcp,
  ]);

  const full = JSON.parse((await f.run("plan", ["--profile", "full"])).stdout);
  assert.deepEqual(full.selection, {
    ipc: true,
    summaries: true,
    startCollector: false,
  });
  assert.deepEqual(full.services.map((service: { label: string }) => service.label), [
    labels.menu, labels.collector, labels.mcp, labels.ipc, labels.pipeline,
  ]);

  await assert.rejects(
    f.run("plan", ["--profile", "core", "--with-ipc"]),
    /cannot be combined/,
  );
  await assert.rejects(
    f.run("plan", ["--profile", "everything"]),
    /Unknown profile/,
  );
});

test("install stops a legacy manual pipeline before replacing the runtime", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const history = join(f.home, ".open-codex-computer-history");
  const legacyLock = join(history, "pipeline.lock");
  const script = join(f.root, "pipeline.mjs");
  await mkdir(history, { recursive: true });
  await writeFile(script, `
import { rmSync } from "node:fs";
const lock = process.argv[3];
process.on("SIGTERM", () => {
  rmSync(lock, { force: true });
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script, "run", legacyLock], { stdio: "ignore" });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await once(child, "spawn");
  await writeFile(legacyLock, `${child.pid}\n`);
  const exited = once(child, "exit");

  await f.run("install", ["--with-summaries"]);
  await exited;
  await assert.rejects(readFile(legacyLock, "utf8"), { code: "ENOENT" });
});

test("upgrade preserves an installed MCP port and explicit override changes it", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const mcpFile = join(f.home, "Library/LaunchAgents", `${labels.mcp}.plist`);
  assert.equal(JSON.parse((await f.run("plan")).stdout).endpoint, "http://127.0.0.1:3317/mcp");
  await f.run("install", ["--mcp-port", "4417"]);
  const legacy = (await readFile(mcpFile, "utf8")).replace(
    "<key>OPEN_HISTORY_MCP_PORT</key><string>4417</string>", "",
  );
  await writeFile(mcpFile, legacy);
  const plan = JSON.parse((await f.run("plan")).stdout);
  assert.equal(plan.endpoint, "http://127.0.0.1:4417/mcp");
  assert.equal(plan.services.find((service: { label: string }) => service.label === labels.mcp)
    .environment.OPEN_HISTORY_MCP_PORT, "4417");
  await f.run("install");
  assert.match(await readFile(mcpFile, "utf8"), /<string>--port<\/string><string>4417<\/string>/);
  assert.equal(JSON.parse((await f.run("plan", ["--mcp-port", "4420"])).stdout).endpoint,
    "http://127.0.0.1:4420/mcp");
  await f.run("install", ["--mcp-port", "4420"]);
  assert.equal(JSON.parse((await f.run("plan")).stdout).endpoint, "http://127.0.0.1:4420/mcp");
});

test("invalid saved MCP port fails closed; explicit override repairs it", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const mcpFile = join(f.home, "Library/LaunchAgents", `${labels.mcp}.plist`);
  await f.run("install", ["--mcp-port", "4417"]);
  const original = await readFile(mcpFile, "utf8");
  await writeFile(mcpFile, original.replace(
    "<key>OPEN_HISTORY_MCP_PORT</key><string>4417</string>",
    "<key>OPEN_HISTORY_MCP_PORT</key><string>invalid</string>",
  ));
  await assert.rejects(f.run("plan"), /Invalid MCP port/);
  await assert.rejects(f.run("install"), /Invalid MCP port/);
  await f.run("install", ["--mcp-port", "4418"]);
  assert.equal(JSON.parse((await f.run("plan")).stdout).endpoint, "http://127.0.0.1:4418/mcp");

  const current = await readFile(mcpFile, "utf8");
  await writeFile(mcpFile, current.replace(
    "<string>--port</string><string>4418</string>",
    "<string>--port</string><string>4419</string>",
  ));
  await assert.rejects(f.run("plan"), /disagrees with --port/);
  await writeFile(mcpFile, "<plist>broken");
  await assert.rejects(f.run("plan"), /Cannot read existing MCP LaunchAgent/);
  await f.run("uninstall");
  assert.deepEqual((await readdir(f.loaded)).filter((name) => name !== "operations"), []);
});

test("failure before and during replacement restores the old app, runtime, and plists", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run("install", ["--with-ipc"]);
  const app = join(f.home, ".local/share/Open Computer History.app/Contents/MacOS/open-history");
  const runtime = join(f.home, ".local/share/open-computer-history/runtime/package.json");
  const plistPath = join(f.home, "Library/LaunchAgents", `${labels.mcp}.plist`);
  const before = await readFile(plistPath);
  await writeFile(app, "old app\n");
  await writeFile(runtime, "old runtime\n");
  for (const point of ["stop", "app-backup", "runtime-backup"]) {
    await assert.rejects(f.run("install", [], { OPEN_HISTORY_INSTALL_FAIL_AT: point }));
    assert.equal(await readFile(app, "utf8"), "old app\n", point);
    assert.equal(await readFile(runtime, "utf8"), "old runtime\n", point);
    assert.deepEqual(await readFile(plistPath), before, point);
  }
  await assert.rejects(f.run("install", [], { FAKE_FAIL_LABEL: labels.mcp }));
  assert.equal(await readFile(app, "utf8"), "old app\n");
  assert.equal(await readFile(runtime, "utf8"), "old runtime\n");
  assert.deepEqual(await readFile(plistPath), before);
});

test("rollback restarts a previously running managed collector", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run("install");
  const app = join(f.home, ".local/share/Open Computer History.app/Contents/MacOS/open-history");
  await writeFile(app, '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 1; done\n');
  await chmod(app, 0o755);
  const child = spawn(app, ["record"], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((done) => setTimeout(done, 100));
  await writeFile(join(f.home, ".open-codex-computer-history/runtime.json"), JSON.stringify({
    state: "running", processIdentifier: child.pid,
  }));
  await assert.rejects(f.run("install", [], { OPEN_HISTORY_INSTALL_FAIL_AT: "runtime-backup" }));
  const operations = await readFile(join(f.loaded, "operations"), "utf8");
  assert.match(operations, new RegExp(`kickstart\\|${labels.collector}`));
  assert.match(await readFile(app, "utf8"), /while :; do sleep 1/);
});

test("upgrade resumes a manually running collector without enabling login capture", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run("install");
  const app = join(f.home, ".local/share/Open Computer History.app/Contents/MacOS/open-history");
  const runtime = join(f.home, ".open-codex-computer-history/runtime.json");
  const operations = join(f.loaded, "operations");
  const collectorPlist = join(f.home, "Library/LaunchAgents", `${labels.collector}.plist`);
  const startManual = async () => {
    await writeFile(app, '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 1; done\n');
    await chmod(app, 0o755);
    const child = spawn(app, ["record"], { stdio: "ignore" });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    await new Promise((done) => setTimeout(done, 100));
    await writeFile(runtime, JSON.stringify({ state: "running", processIdentifier: child.pid }));
  };
  await startManual();
  const plan = JSON.parse((await f.run("plan")).stdout);
  assert.equal(plan.selection.startCollector, false);
  assert.equal(plan.restartRunningCollector, true);
  await writeFile(operations, "");
  await f.run("install");
  assert.match(await readFile(operations, "utf8"), new RegExp(`kickstart\\|${labels.collector}`));
  assert.match(await readFile(collectorPlist, "utf8"), /<key>RunAtLoad<\/key><false\/>/);

  await startManual();
  await writeFile(operations, "");
  await f.run("install", ["--no-start-collector"]);
  assert.doesNotMatch(await readFile(operations, "utf8"), /kickstart/);
  assert.match(await readFile(collectorPlist, "utf8"), /<key>RunAtLoad<\/key><false\/>/);
});
