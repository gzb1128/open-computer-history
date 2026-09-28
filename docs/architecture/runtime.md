# Installed runtime and service ownership

The local bundle contains a signed macOS app and a Node runtime. The app
contains the menu and `open-history` collector executables. The Node runtime
contains the built MCP server, native IPC server, summary pipeline, their
dependencies, and package metadata. `scripts/local-service-manifest.mjs` is
the source for all installed LaunchAgent labels, arguments, environment, logs,
and startup behavior. Installation paths and commands are in
[local installation](../installation.md).

The collector owns event capture, policy enforcement, and `runtime.json`
status. Its `collector.lock` prevents two recorder processes from writing
concurrently. The menu and MCP control actions are clients of the collector:
they read its status and use the loaded collector LaunchAgent to start it
after explicit user action. The installed menu and MCP agents receive
`OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT=dev.opencomputerhistory.collector`.
The MCP also receives `OPEN_HISTORY_COLLECTOR_BIN` for native lifecycle
commands. When this LaunchAgent environment is absent, source checkout tools
can use the development collector path.

The collector LaunchAgent is loaded on a fresh install but has
`RunAtLoad=false` and `KeepAlive=false`. The menu starts at login and has
`KeepAlive=false`, so Quit does not respawn it. MCP starts at login and is
kept alive; IPC and summaries are installed only when selected. Summary
generation is separate from recording and invokes Codex only when that
optional pipeline is enabled. The history directory and `config.json` are
outside the installed bundle and survive upgrade and uninstall.

The optional `config.json` `timeZone` selects the IANA zone used for new
summary prompts and MCP display fields; absent, null, or blank uses the host
zone. Event timestamps, summary filenames, timeline `start`/`end`, pipeline
bucket boundaries, and deduplication keys stay UTC. New Markdown memories
declare their summary time zone in frontmatter. Existing memories are not
rewritten: if they have no zone metadata, times in their title, description,
and body have unknown provenance. Timeline and search expose this as
`summaryTimeZone: null`, independent of the response zone used for local event
timestamps.

The installer stages a complete replacement, stops managed agents and a
recognized running collector, swaps app and runtime paths, registers the new
services, and checks MCP startup. On failure it restores the prior binaries
and service plists. The installer does not grant macOS privacy permissions;
the menu requests them through the installed collector executable and shows
the collector's last reported result.
