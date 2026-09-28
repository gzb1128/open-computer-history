import { join } from "node:path";

export const labels = Object.freeze({
  menu: "dev.opencomputerhistory.menu",
  collector: "dev.opencomputerhistory.collector",
  mcp: "dev.opencomputerhistory.mcp",
  ipc: "dev.opencomputerhistory.ipc",
  pipeline: "dev.opencomputerhistory.pipeline",
});
export const defaultMCPPort = 3317;

export function serviceManifest({ home, node, app, runtime, port = defaultMCPPort, ipc = false, summaries = false, startCollector = false }) {
  const history = join(home, ".open-codex-computer-history");
  const logs = join(home, "Library", "Logs", "OpenComputerHistory");
  const collector = join(app, "Contents", "MacOS", "open-history");
  const environment = {
    HOME: home,
    OPEN_COMPUTER_HISTORY_HOME: history,
    OPEN_HISTORY_COLLECTOR_BIN: collector,
    OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT: labels.collector,
    OPEN_HISTORY_MCP_PORT: String(port),
    PATH: [join(node, ".."), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
  };
  const service = (name, args, options = {}) => ({
    label: labels[name],
    arguments: args,
    workingDirectory: options.workingDirectory ?? runtime,
    runAtLoad: options.runAtLoad ?? true,
    keepAlive: options.keepAlive ?? false,
    environment,
    stdout: options.stdout ?? join(logs, `${labels[name]}.out.log`),
    stderr: options.stderr ?? join(logs, `${labels[name]}.err.log`),
  });
  return [
    service("menu", [join(app, "Contents", "MacOS", "Open Computer History")], { workingDirectory: home }),
    service("collector", [collector, "record", "--no-prompt"], {
      runAtLoad: startCollector,
      stdout: join(history, "collector.stdout.log"),
      stderr: join(history, "collector.stderr.log"),
    }),
    service("mcp", [node, join(runtime, "node_modules", "@mcp-use", "cli", "dist", "bin.js"), "start", "--host", "127.0.0.1", "--port", String(port), "--path", runtime], { keepAlive: true }),
    ...(ipc ? [service("ipc", [node, join(runtime, "bin", "native-ipc.mjs")], { keepAlive: true })] : []),
    ...(summaries ? [service("pipeline", [node, join(runtime, "bin", "pipeline.mjs"), "run"], { keepAlive: true })] : []),
  ];
}

export function plist(service) {
  const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const string = (value) => `<string>${xml(value)}</string>`;
  const key = (value) => `<key>${xml(value)}</key>`;
  const bool = (value) => value ? "<true/>" : "<false/>";
  const env = Object.entries(service.environment).map(([name, value]) => `${key(name)}${string(value)}`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${key("Label")}${string(service.label)}
${key("ProgramArguments")}<array>${service.arguments.map(string).join("")}</array>
${key("WorkingDirectory")}${string(service.workingDirectory)}
${key("RunAtLoad")}${bool(service.runAtLoad)}
${key("KeepAlive")}${bool(service.keepAlive)}
${key("EnvironmentVariables")}<dict>${env}</dict>
${key("StandardOutPath")}${string(service.stdout)}
${key("StandardErrorPath")}${string(service.stderr)}
</dict></plist>
`;
}
