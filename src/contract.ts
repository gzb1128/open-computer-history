import { defaultMCPPort, labels } from "../scripts/local-service-manifest.mjs";

export const DEFAULT_MCP_PORT = defaultMCPPort;
export const COLLECTOR_LAUNCH_AGENT = labels.collector;
export const MCP_LAUNCH_AGENT = labels.mcp;
export const MENU_LAUNCH_AGENT = labels.menu;
export const PIPELINE_LAUNCH_AGENT = labels.pipeline;
export const IPC_LAUNCH_AGENT = labels.ipc;

export function mcpEndpoint(port?: number): string {
  const configured = port ?? (process.env.OPEN_HISTORY_MCP_PORT === undefined
    ? DEFAULT_MCP_PORT : Number(process.env.OPEN_HISTORY_MCP_PORT));
  if (!Number.isInteger(configured) || configured < 1 || configured > 65535) {
    throw new Error(`Invalid OPEN_HISTORY_MCP_PORT: ${process.env.OPEN_HISTORY_MCP_PORT ?? String(configured)}`);
  }
  return `http://127.0.0.1:${configured}/mcp`;
}
