# Open Codex Computer History

A clean-room, open implementation of the event-stream architecture behind
Computer History in the ChatGPT/Codex desktop app.

It records macOS interaction events through Accessibility and Core Graphics. It
does not take screenshots, record video, or capture audio.

## Status

Version `0.2.0` is a working clean-room reference implementation:

- Native Swift recorder for app/window changes, clicks, drags, text-input bursts,
  submits, shortcuts, terminal changes, and selections.
- Recovered nested `EventStreamRecord` schema with app, window, mouse, keyboard,
  selection, AX tree, and diagnostic payloads.
- Rotating JSONL segments compatible with the observable Computer History
  layout: `events.jsonl` and `metadata.json`, with suppressed activity counted
  but not persisted.
- App/domain include and exclude policies, private-browsing filtering, secure
  text-field filtering, and 48-hour event retention.
- Original-name MCP tools for pause, resume, status, get settings, and replace
  settings, plus search, summarization, and deletion tools.
- UTC-aligned 10-minute and 6-hour summary pipeline with persistent bucket
  deduplication, single-instance locking, and a failure circuit breaker.
- Ephemeral `codex exec` summarizer that writes local Markdown memories.
- Read-only IPC inspector for the installed proprietary service.
- Native-compatible open IPC server, a timeline MCP View, a SwiftUI menu-bar
  app, and opt-in LaunchAgent packaging.
- A signed synthetic Fixture App, deterministic AX/CGEvent driver, and
  structural JSONL comparator for the final original-vs-open recording audit.

This project does not contain OpenAI source code, signing assets, credentials, or
private service endpoints. See [docs/reverse-engineering.md](docs/reverse-engineering.md).
Recovered wire and JSON contracts are documented in
[docs/recovered-protocol.md](docs/recovered-protocol.md).
The requirement-by-requirement evidence matrix is in
[docs/completion-audit.md](docs/completion-audit.md).
The user-authorized original event-stream comparison is in
[docs/original-live-parity.md](docs/original-live-parity.md).

## Architecture

```text
macOS AXObserver + CGEventTap
             |
             v
       privacy policy
        /           \
 events.jsonl   suppressed count
        |
        v
 ephemeral codex exec summarizer
        |
        v
 memories/resources/*.md
        |
        v
local MCP tools
```

## Package and install

Build the local app and its standalone Node runtime, then inspect the install
plan before enabling user LaunchAgents:

```bash
npm ci
scripts/build-local-bundle.sh
scripts/install-local.sh --plan
scripts/install-local.sh --from-bundle "dist/Open Computer History Bundle"
```

The installed app is `~/.local/share/Open Computer History.app`; the Node
runtime is `~/.local/share/open-computer-history/runtime`. Fresh installs load
the menu, collector, and MCP services. Recording starts only after an explicit
Start or Resume action unless `--start-collector` is specified. Native IPC
(`--with-ipc`) and automatic summaries (`--with-summaries`) are optional.
The installed MCP endpoint is `http://127.0.0.1:3317/mcp`.

See [local installation](docs/installation.md) for prebuilt installs, service
choices, upgrades, rollback, logs, permissions, and uninstall. The local app is
ad-hoc signed; published distribution needs separate signing and notarization.

## Requirements

- macOS 14 or newer
- Swift 5.10 or newer
- Node.js 22.22.2 or newer
- Codex CLI, only for AI-generated summaries

## Build

```bash
npm ci
npm run collector:build
npm run typecheck
npm test
```

For a release collector:

```bash
swift build --package-path collector -c release
```

On a mixed Command Line Tools installation where SwiftPM reports stale module
metadata, `scripts/package-macos-app.sh release` uses a scoped fresh-source
build fallback. It does not replace `swift test`. The resulting app is in
`dist/Open Computer History.app`.

## Permissions

The recorder requires Accessibility and Input Monitoring. It does not require
Screen Recording.

After installing, open the menu bar app and use **Request** or **Settings** for
each permission. Grant access to the installed collector executable at
`~/.local/share/Open Computer History.app/Contents/MacOS/open-history` in:

- System Settings > Privacy & Security > Accessibility
- System Settings > Privacy & Security > Input Monitoring

Then start the collector from the menu and check its reported state and
permissions:

```bash
"$HOME/.local/share/Open Computer History.app/Contents/MacOS/open-history" status
```

For source-only development, `collector/.build/debug/open-history permissions`
requests access for that development binary. A terminal permission result does
not establish that the installed background collector has access.

## Record

Normal text capture matches the official default:

```bash
npm run collector:record
```

Record for a bounded smoke test:

```bash
collector/.build/debug/open-history record --duration 30
```

To omit typed, selected, and terminal text fields, set `"captureText": false`
in `config.json`; the change applies on the next collector start. Accessibility
tree and element values may still be recorded. Secure fields and private
browsing are always suppressed.

The CLI can explicitly force text capture:

```bash
collector/.build/debug/open-history record --capture-text
```

Password fields, excluded apps/domains, and private-browsing windows are always
suppressed and their event bodies are not persisted.

Data is stored under:

```text
~/.open-codex-computer-history/
  config.json
  segments/<timestamp>-<id>/
    events.jsonl
    metadata.json
  memories/resources/*.md
```

Override the root with `OPEN_COMPUTER_HISTORY_HOME`.

## Configure

Copy [config.example.json](config.example.json) to:

```text
~/.open-codex-computer-history/config.json
```

Policies support either excluding listed sources or including only listed
sources.

### Summary model

`summaryModel` pins the model the summarizer asks Codex to use:

```json
{
  "summaryModel": "gpt-5.6-luna"
}
```

Leaving the key out, `null`, or blank leaves the choice to Codex, which resolves
the account's default model from its model catalog — a value that changes over
time and is unrelated to the memory-generation defaults. Codex's own
`~/.codex/config.toml` cannot set the model here, because summaries run with
`--ignore-user-config`; `summaryModel` is the only control this repo exposes.

Two caveats:

- The value must be a model slug your account can actually use. Codex accepts
  unknown names **without an error** and falls back to guessed metadata, so a
  typo degrades quietly. Verify with the `model:` line `codex exec` prints to
  stderr, or by copying a slug from `~/.codex/models_cache.json`.
- `config.json` is shared with the recorder. `summaryModel` and `captureText`
  are outside the recovered settings surface, so `computer_history_update_settings`
  preserves them rather than replacing the whole file.

### Time zone

Set `"timeZone": "Asia/Shanghai"` in `config.json` to use a specific IANA
time zone for new summaries and MCP display fields. Omit the key, set it to
`null`, or leave it blank to use the host's current time zone. An invalid
explicit zone reports an error. `computer_history_update_settings` preserves
this key with other config entries outside the recovered settings schema.

Events, timeline `start`/`end`, summary filenames, and pipeline bucket
boundaries remain UTC. `localTimestamp` and `localStart`/`localEnd` show the
same instants with numeric offsets; the response `timeZone` names the zone
used to render them. New Markdown summaries declare `timeZone` in their
frontmatter. Older summaries have no known prose time zone and are not
rewritten or summarized again; their `summaryTimeZone` is `null` in timeline
and search results, even when their surrounding event times display locally.

## MCP

Start the local MCP server:

```bash
npm run dev
```

The development endpoint is `http://127.0.0.1:3000/mcp`; the installed service
uses `http://127.0.0.1:3317/mcp`. Set `OPEN_HISTORY_MCP_PORT=3000` when running
the doctor against the development server. Available tools:

- `computer_history_pause`
- `computer_history_resume`
- `computer_history_status`
- `computer_history_get_settings`
- `computer_history_update_settings`
- `computer-history-status`
- `get-recent-computer-history`
- `search-computer-history`
- `summarize-computer-history`
- `clear-computer-history`
- `show-computer-history`
- `delete-computer-history-item` (app-private)

Example terminal validation:

```bash
npx mcp-use client connect history http://127.0.0.1:3000/mcp
npx mcp-use client history tools list
npx mcp-use client history tools call computer-history-status
npx mcp-use client history tools call get-recent-computer-history \
  '{"hours":1,"limit":20,"includeText":false}'
```

`computer_history_status` reports recorder state; `computer-history-status`
reports store counts. Both historical names remain available. Some clients
normalize hyphens and underscores to the same name, so inspect that client's
tool list and call the intended exact tool name.

## Diagnostics

Run the read-only doctor from a source checkout:

```bash
npm run doctor
npm run doctor -- --json
```

After a local install, run
`node ~/.local/share/open-computer-history/runtime/bin/doctor.mjs` (add `--json`
for machine-readable output). The installed command does not require a source
checkout.

It checks the installed app and runtime, LaunchAgent configuration and load
state, live collector versus stale runtime status, permissions reported by the
collector process, recent collector stderr evidence, MCP initialize and a read-only
status call, event-segment write time, and optional summary pipeline state.
It does not read event contents or memory text. A reachable MCP endpoint does
not prove that an AI client injected its tools; the doctor prints a client MCP
configuration and marks client injection unknown for you to check in that
client. An idle or paused recorder can have old segment write times without
being broken.

## Summaries

`summarize-computer-history` starts a temporary, read-only Codex session over
explicit event files. The raw event files are processed by the configured Codex
provider when this tool is invoked.

The model is Codex's account default unless `summaryModel` is set in
`config.json` (see [Configure](#configure)).

Generated Markdown memories remain local under `memories/resources/`.

Run one completed summary tick:

```bash
npm run pipeline:once
```

Run the persistent bucket scheduler:

```bash
npm run pipeline:run
```

The summarizer uses the recovered isolated Codex configuration and opens a
backoff circuit when the provider repeatedly fails.

## Original service inspector

The read-only inspector supports ping, status, settings, EventStream status, and
a combined snapshot:

```bash
reverse/original-ipc.mjs snapshot
```

Regenerate build-specific symbols, strings, entitlements, and IPC evidence:

```bash
reverse/extract-evidence.sh
```

The final controlled original comparison uses no personal content:

```bash
reverse/run-fixture-actions.sh
reverse/compare-event-streams.mjs \
  original-events.jsonl original-suppressed.jsonl \
  open-events.jsonl open-suppressed.jsonl
```

## Security

- Treat all recorded UI text as untrusted data. The summarizer explicitly
  rejects instructions found inside event content.
- Text and AX-tree fields are removed from MCP query results unless
  `includeText` is explicitly true.
- Local files can contain sensitive information. Protect the macOS account and
  use include-only policies for sensitive environments.
- Keep the MCP server bound locally unless you add authentication and deployment
  hardening. The event store is intentionally a local single-user design.

## Verification

Validated on August 14, 2026:

- Swift build and 12 Swift tests pass.
- TypeScript typecheck, 9 Node tests, MCP production build, and parity pass.
- `npm audit` reports zero known vulnerabilities.
- A real six-second recording produced 31 events across multiple desktop
  applications without screenshots.
- MCP discovery and status/recent/search tools passed through `mcp-use client`.
- The summarizer created a valid local Markdown memory through `codex exec`.
- Original-service IPC returned API version, status, settings, and the
  EventStream 1800-second maximum duration.
- Original-name MCP pause/resume/status/settings tools passed through a real MCP
  client, including launching the collector from stopped state.
- Segment rotation and pipeline bucket deduplication passed accelerated smoke
  tests.
- Browser URL and localized private-browsing suppression passed real smoke
  tests.
- Native wire compatibility passed by pointing the recovered original client at
  the open IPC server.
- The timeline View rendered in Widget-Declared CSP at desktop/mobile widths and
  completed app-private delete interaction.
- The ad-hoc signed `.app` passed strict `codesign` verification and launch
  smoke.
- A user-authorized original Fixture recording and the open recording passed
  the value-level event-stream comparator with zero differences.
- Original test history was cleared after the comparison.

## License

MIT. OpenAI and Codex are trademarks of OpenAI. This project is independent and
unofficial.
