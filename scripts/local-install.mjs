#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { closeSync, openSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { defaultMCPPort, labels, plist, serviceManifest } from "./local-service-manifest.mjs";

const allLabels = Object.values(labels);

function argumentsFor(command, argv) {
  const options = { command, home: process.env.HOME || homedir(), node: process.execPath };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--from-bundle" || arg === "--mcp-port" || arg === "--home" || arg === "--node") {
      if (!argv[index + 1]) throw new Error(`Missing value for ${arg}`);
      const key = { "--from-bundle": "bundle", "--mcp-port": "port", "--home": "home", "--node": "node" }[arg];
      options[key] = argv[++index];
    } else if (arg === "--with-ipc") options.ipc = true;
    else if (arg === "--without-ipc") options.ipc = false;
    else if (arg === "--with-summaries") options.summaries = true;
    else if (arg === "--without-summaries") options.summaries = false;
    else if (arg === "--start-collector") options.startCollector = true;
    else if (arg === "--no-start-collector") options.startCollector = false;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.home = resolve(options.home);
  options.node = resolve(options.node);
  if (options.port !== undefined) options.port = validPort(options.port, "--mcp-port");
  if (options.bundle) options.bundle = resolve(options.bundle);
  return options;
}

function validPort(value, source) {
  if (typeof value !== "string" || !/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error(`Invalid MCP port in ${source}: ${String(value)}`);
  }
  const port = Number(value);
  if (port > 65535) throw new Error(`Invalid MCP port in ${source}: ${value}`);
  return port;
}

function installedMCPPort(file) {
  const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
  if (converted.error || converted.status !== 0) {
    throw new Error(`Cannot read existing MCP LaunchAgent ${file}: ${converted.error?.message || converted.stderr.trim()}`);
  }
  let config;
  try {
    config = JSON.parse(converted.stdout);
  } catch (error) {
    throw new Error(`Invalid existing MCP LaunchAgent ${file}: ${error}`);
  }
  if (config?.Label !== labels.mcp || !Array.isArray(config.ProgramArguments)) {
    throw new Error(`Invalid existing MCP LaunchAgent ${file}: label or ProgramArguments is missing`);
  }
  const argumentsList = config.ProgramArguments;
  const portPositions = argumentsList.flatMap((arg, index) => arg === "--port" ? [index] : []);
  if (portPositions.length !== 1 || portPositions[0] + 1 >= argumentsList.length) {
    throw new Error(`Invalid existing MCP LaunchAgent ${file}: expected one --port argument`);
  }
  const argumentPort = validPort(argumentsList[portPositions[0] + 1], `${file} ProgramArguments`);
  const environment = config.EnvironmentVariables;
  if (environment != null && (typeof environment !== "object" || Array.isArray(environment))) {
    throw new Error(`Invalid existing MCP LaunchAgent ${file}: EnvironmentVariables is not a dictionary`);
  }
  if (environment && Object.hasOwn(environment, "OPEN_HISTORY_MCP_PORT")) {
    const environmentPort = validPort(environment.OPEN_HISTORY_MCP_PORT, `${file} OPEN_HISTORY_MCP_PORT`);
    if (environmentPort !== argumentPort) {
      throw new Error(`Invalid existing MCP LaunchAgent ${file}: OPEN_HISTORY_MCP_PORT ${environmentPort} disagrees with --port ${argumentPort}`);
    }
  }
  return argumentPort;
}

function paths(home) {
  const share = join(home, ".local", "share");
  return {
    share,
    app: join(share, "Open Computer History.app"),
    runtime: join(share, "open-computer-history", "runtime"),
    agents: join(home, "Library", "LaunchAgents"),
    history: join(home, ".open-codex-computer-history"),
  };
}

async function exists(path) {
  return stat(path).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function installedState(options) {
  const path = paths(options.home);
  const managed = {};
  for (const [name, label] of Object.entries(labels)) {
    const file = join(path.agents, `${label}.plist`);
    managed[name] = await exists(file);
  }
  if (options.command !== "uninstall" && options.port === undefined) {
    options.port = managed.mcp
      ? installedMCPPort(join(path.agents, `${labels.mcp}.plist`))
      : defaultMCPPort;
  }
  let priorAutoCollector = false;
  if (managed.collector) {
    const xml = await readFile(join(path.agents, `${labels.collector}.plist`), "utf8");
    priorAutoCollector = /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(xml);
  }
  const priorRecorder = await runningRecorder(path.history);
  const selection = {
    ipc: options.ipc ?? managed.ipc,
    summaries: options.summaries ?? managed.pipeline,
    startCollector: options.startCollector ?? priorAutoCollector,
  };
  return { path, managed, selection, priorAutoCollector, priorRecorder };
}

async function runningRecorder(history) {
  try {
    const runtime = JSON.parse(await readFile(join(history, "runtime.json"), "utf8"));
    if (runtime.state !== "running" && runtime.state !== "paused") return null;
    const pid = runtime.processIdentifier;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    const ps = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    const command = ps.status === 0 ? ps.stdout.trim() : "";
    return /(?:^|\/)open-history(?:\s|$)/.test(command) && /\brecord\b/.test(command) ? pid : null;
  } catch {
    return null;
  }
}

function launchctl(args, { allowFailure = false } = {}) {
  const binary = process.env.OPEN_HISTORY_INSTALL_LAUNCHCTL || "/bin/launchctl";
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(`launchctl ${args.join(" ")} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.status === 0;
}

async function waitForUnloaded(domain, label) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!launchctl(["print", `${domain}/${label}`], { allowFailure: true })) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`LaunchAgent ${label} remained loaded after bootout`);
}

async function bootstrap(domain, file, label) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (launchctl(["bootstrap", domain, file], { allowFailure: true })) {
      if (launchctl(["print", `${domain}/${label}`], { allowFailure: true })) return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  launchctl(["bootstrap", domain, file]);
  throw new Error(`LaunchAgent ${label} was not registered`);
}

async function portIsOpen(port) {
  return await new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); done(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function waitForMCP(port) {
  if (process.env.OPEN_HISTORY_INSTALL_LAUNCHCTL) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await portIsOpen(port)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`MCP endpoint did not open on 127.0.0.1:${port}`);
}

function failAt(point) {
  if (process.env.NODE_ENV === "test" && process.env.OPEN_HISTORY_INSTALL_FAIL_AT === point) {
    throw new Error(`Injected installation failure at ${point}`);
  }
}

async function stopRecorder(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Recorder process ${pid} did not stop; installation aborted to avoid duplicate capture`);
}

async function preflight(bundle) {
  if (!bundle) throw new Error("Install requires --from-bundle PATH");
  const app = join(bundle, "Open Computer History.app");
  for (const file of [
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
    if (!await exists(join(bundle, file))) throw new Error(`Bundle is incomplete: ${file}`);
  }
  for (const file of [
    "Open Computer History.app/Contents/MacOS/Open Computer History",
    "Open Computer History.app/Contents/MacOS/open-history",
  ]) {
    await access(join(bundle, file), constants.X_OK);
  }
  const manifest = JSON.parse(await readFile(join(bundle, "runtime/.mcp-use/build/manifest.json"), "utf8"));
  for (const [name, view] of Object.entries(manifest.views ?? {})) {
    await access(join(bundle, "runtime/.mcp-use/build/views", name, view.entry));
    for (const css of view.css ?? []) await access(join(bundle, "runtime/.mcp-use/build/views", name, css));
  }
  if (!process.env.OPEN_HISTORY_INSTALL_LAUNCHCTL) {
    const checked = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
    if (checked.status !== 0) throw new Error(`App signature verification failed: ${checked.stderr.trim()}`);
  }
}

function renderPlan(options, state) {
  const { path, managed, selection, priorAutoCollector, priorRecorder } = state;
  const services = serviceManifest({
    home: options.home, node: options.node, app: path.app, runtime: path.runtime,
    port: options.port, ...selection,
  });
  return {
    bundle: options.bundle ?? null,
    app: path.app,
    runtime: path.runtime,
    history: path.history,
    endpoint: `http://127.0.0.1:${options.port}/mcp`,
    selection,
    preserved: {
      ipc: options.ipc === undefined && managed.ipc,
      summaries: options.summaries === undefined && managed.pipeline,
      collectorStart: options.startCollector === undefined && (priorAutoCollector || Boolean(priorRecorder)),
    },
    priorRecorderPid: priorRecorder,
    restartRunningCollector: Boolean(priorRecorder && options.startCollector !== false),
    services,
    removedLabels: allLabels.filter((label) => !services.some((service) => service.label === label)),
  };
}

async function install(options, state) {
  const version = process.versions.node.split(".").map(Number);
  if (version[0] < 22 || (version[0] === 22 && (version[1] < 22 || (version[1] === 22 && version[2] < 2)))) {
    throw new Error("Node.js 22.22.2 or newer is required for the installed MCP runtime");
  }
  await preflight(options.bundle);
  await access(options.node, constants.X_OK);
  const { path } = state;
  const domain = `gui/${process.getuid()}`;
  await mkdir(path.share, { recursive: true });
  const stage = await mkdtemp(join(path.share, ".open-computer-history-install-"));
  const stagedApp = join(stage, "app");
  const stagedRuntime = join(stage, "runtime");
  const backup = join(stage, "backup");
  const previous = new Map();
  let stopped = false;
  let movedOldApp = false;
  let movedOldRuntime = false;
  let installedApp = false;
  let installedRuntime = false;
  let cleanupStage = true;
  try {
    await cp(join(options.bundle, "Open Computer History.app"), stagedApp, { recursive: true });
    await cp(join(options.bundle, "runtime"), stagedRuntime, { recursive: true });
    state.priorRecorder = await runningRecorder(path.history);
    if (options.startCollector === undefined) {
      state.selection.startCollector = state.priorAutoCollector;
    }
    let plan = renderPlan(options, state);
    await mkdir(join(path.runtime, ".."), { recursive: true });
    await mkdir(path.agents, { recursive: true });
    await mkdir(path.history, { recursive: true, mode: 0o700 });
    await mkdir(join(options.home, "Library", "Logs", "OpenComputerHistory"), { recursive: true });
    await mkdir(backup, { recursive: true });
    for (const label of allLabels) {
      const file = join(path.agents, `${label}.plist`);
      if (await exists(file)) previous.set(label, await readFile(file));
    }
    stopped = true;
    for (const label of previous.keys()) {
      launchctl(["bootout", domain, join(path.agents, `${label}.plist`)], { allowFailure: true });
      await waitForUnloaded(domain, label);
    }
    failAt("stop");
    const recorderToStop = await runningRecorder(path.history);
    if (recorderToStop) {
      state.priorRecorder = recorderToStop;
    }
    plan = renderPlan(options, state);
    await stopRecorder(recorderToStop);
    if (!process.env.OPEN_HISTORY_INSTALL_LAUNCHCTL && await portIsOpen(options.port)) {
      throw new Error(`Port ${options.port} is already in use after stopping the old MCP service`);
    }
    if (await exists(path.app)) {
      await rename(path.app, join(backup, "app"));
      movedOldApp = true;
    }
    failAt("app-backup");
    if (await exists(path.runtime)) {
      await rename(path.runtime, join(backup, "runtime"));
      movedOldRuntime = true;
    }
    failAt("runtime-backup");
    await rename(stagedApp, path.app);
    installedApp = true;
    await rename(stagedRuntime, path.runtime);
    installedRuntime = true;
    for (const label of allLabels) await rm(join(path.agents, `${label}.plist`), { force: true });
    for (const service of plan.services) {
      await writeFile(join(path.agents, `${service.label}.plist`), plist(service), { mode: 0o644 });
    }
    for (const service of plan.services) await bootstrap(domain, join(path.agents, `${service.label}.plist`), service.label);
    if (plan.restartRunningCollector && !plan.selection.startCollector) {
      launchctl(["kickstart", `${domain}/${labels.collector}`]);
    }
    await waitForMCP(options.port);
    console.log(`Installed Open Computer History. MCP endpoint: ${plan.endpoint}`);
    console.log(`App: ${path.app}\nRuntime: ${path.runtime}\nHistory: ${path.history}`);
  } catch (error) {
    if (stopped) {
      try {
        for (const label of allLabels) {
          launchctl(["bootout", domain, join(path.agents, `${label}.plist`)], { allowFailure: true });
          await waitForUnloaded(domain, label);
        }
        await stopRecorder(await runningRecorder(path.history));
        if (installedApp) await rm(path.app, { recursive: true, force: true });
        if (installedRuntime) await rm(path.runtime, { recursive: true, force: true });
        if (movedOldApp) await rename(join(backup, "app"), path.app);
        if (movedOldRuntime) await rename(join(backup, "runtime"), path.runtime);
        for (const label of allLabels) {
          const file = join(path.agents, `${label}.plist`);
          if (previous.has(label)) await writeFile(file, previous.get(label));
          else await rm(file, { force: true });
        }
        for (const label of previous.keys()) {
          await bootstrap(domain, join(path.agents, `${label}.plist`), label);
        }
        if (state.priorRecorder) {
          if (previous.has(labels.collector)) {
            launchctl(["kickstart", `${domain}/${labels.collector}`]);
          } else if (await exists(join(path.app, "Contents/MacOS/open-history"))) {
            const log = join(path.history, "collector.stderr.log");
            const descriptor = openSync(log, "a");
            const child = spawn(join(path.app, "Contents/MacOS/open-history"), ["record", "--no-prompt"], {
              detached: true,
              env: { ...process.env, OPEN_COMPUTER_HISTORY_HOME: path.history },
              stdio: ["ignore", "ignore", descriptor],
            });
            closeSync(descriptor);
            child.unref();
          }
        }
      } catch (rollbackError) {
        cleanupStage = false;
        throw new AggregateError([error, rollbackError], `Installation failed and rollback could not finish; backup remains at ${stage}`);
      }
    }
    throw error;
  } finally {
    if (cleanupStage) await rm(stage, { recursive: true, force: true });
  }
}

async function uninstall(options) {
  const path = paths(options.home);
  const domain = `gui/${process.getuid()}`;
  for (const label of allLabels) {
    const file = join(path.agents, `${label}.plist`);
    if (await exists(file)) {
      launchctl(["bootout", domain, file], { allowFailure: true });
      await waitForUnloaded(domain, label);
      await rm(file, { force: true });
    }
  }
  await stopRecorder(await runningRecorder(path.history));
  await rm(path.app, { recursive: true, force: true });
  await rm(join(path.share, "open-computer-history"), { recursive: true, force: true });
  console.log(`Uninstalled Open Computer History services. History data remains in ${path.history}`);
}

async function main() {
  const command = process.argv[2];
  if (!["plan", "install", "uninstall"].includes(command)) throw new Error("Usage: local-install.mjs plan|install|uninstall [options]");
  const options = argumentsFor(command, process.argv.slice(3));
  const state = await installedState(options);
  if (command === "plan") console.log(JSON.stringify(renderPlan(options, state), null, 2));
  else if (command === "install") await install(options, state);
  else await uninstall(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
