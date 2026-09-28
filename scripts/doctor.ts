import { diagnose, type DiagnosticCheck, type Diagnostics } from "../src/diagnostics.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function formatDiagnostics(report: Diagnostics): string {
  const lines = [
    `Open Computer History doctor (${report.checkedAt})`,
    `Collector: ${report.collector.state}`,
  ];
  const line = (name: string, check: DiagnosticCheck) => {
    const mark = check.ok === true ? "OK" : check.ok === false ? "FAIL" : "UNKNOWN";
    lines.push(`${mark} ${name}: ${check.reason}`);
    if (check.action) lines.push(`  Action: ${check.action}`);
  };
  line("Installed app", report.installation.app);
  line("Installed runtime", report.installation.runtime);
  line("Collector service", report.installation.collectorAgent);
  line("Menu service", report.installation.menuAgent);
  line("Collector process", report.collector.process);
  line("Collector permissions", report.collector.permissions.check);
  if (report.collector.startupCause) lines.push(`Last collector stderr line (may be historical): ${report.collector.startupCause}`);
  line("MCP service", report.mcp.agent);
  line("MCP endpoint", report.mcp.reachable);
  line("MCP handshake", report.mcp.handshake);
  line("MCP read-only call", report.mcp.readOnlyCall);
  line("Client tool injection", report.mcp.clientInjected);
  line("Recent data", report.data.check);
  if (report.data.latestWriteAt) lines.push(`Latest event segment write: ${report.data.latestWriteAt}`);
  line("Summaries", report.summaries.check);
  lines.push(`MCP endpoint: ${report.mcp.endpoint}`);
  lines.push(`Client MCP config: ${JSON.stringify(report.clientConfig)}`);
  return lines.join("\n");
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  diagnose().then((report) => {
    console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDiagnostics(report));
    if ([report.installation.app, report.installation.runtime, report.collector.process,
      report.collector.permissions.check, report.mcp.handshake, report.mcp.readOnlyCall]
      .some((check) => check.ok === false)) process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
