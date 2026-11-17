# Local installation

The local installer copies a built app and Node runtime into stable paths. The
LaunchAgents do not refer to the source checkout or Swift's `.build` directory.
It does not configure Accessibility or Input Monitoring automatically.

| Item | Path |
| --- | --- |
| App and collector | `~/.local/share/Open Computer History.app` |
| MCP, IPC, and summary runtime | `~/.local/share/open-computer-history/runtime` |
| History and settings | `~/.open-codex-computer-history` |
| LaunchAgents | `~/Library/LaunchAgents/dev.opencomputerhistory.*.plist` |
| Collector startup errors | `~/.open-codex-computer-history/collector.stderr.log` |
| Other service logs | `~/Library/Logs/OpenComputerHistory/` |

The installer uses the Node executable that invoked it. Node.js 22.22.2 or
newer remains an external runtime dependency; moving or removing that
executable breaks the MCP, IPC, and summary agents until reinstall. Codex CLI
is needed only if automatic summaries are enabled.

From a source checkout, install dependencies once, then build and install:

```sh
npm ci
scripts/install-local.sh --plan
scripts/install-local.sh --profile core
```

`--plan` reads the current service choices and prints the proposed paths and
manifest without building, changing services, or recording. The source build
produces `dist/Open Computer History Bundle`, containing the app and the Node
runtime. For a separate machine with Node already installed, copy that bundle
and run its included installer without a compiler or source checkout:

```sh
"/path/to/Open Computer History Bundle/scripts/install-local.sh"
```

The fresh installation loads menu, collector, and MCP agents. The collector
waits for an explicit Resume or Start action; `--start-collector` opts into
starting it at installation and login. The menu has no KeepAlive, so Quit leaves
it closed. MCP serves `http://127.0.0.1:3317/mcp`.

Use a service profile to make the installed LaunchAgent set explicit:

```sh
scripts/install-local.sh --profile core
scripts/install-local.sh --profile full
```

`core` installs the menu, collector, and MCP. `full` also installs native IPC and
automatic summaries. A profile cannot be combined with the individual
`--with-*` or `--without-*` service flags.

Native IPC and automatic summaries are optional:

```sh
scripts/install-local.sh --with-ipc --with-summaries
scripts/install-local.sh --without-ipc --without-summaries
```

An upgrade without a profile preserves previously installed IPC and summary
agents, plus an existing collector's automatic start choice. A manually running
collector is stopped during replacement and started once from the stable app
bundle; this does not enable recording at future logins. The installer also
stops a recognized legacy manual summary pipeline before swapping runtimes so
the old and new lock implementations cannot run concurrently. Explicit
`--without-*` and `--no-start-collector` flags override those preserved choices.
The installer stages the new bundle, stops managed agents, swaps the app and
runtime, and restores the old installation if service registration or MCP
startup fails. History data and `config.json` are never part of that swap.

To remove installed services and binaries while preserving history and
settings, run:

```sh
scripts/uninstall-local.sh
```

An installation from a prebuilt bundle also includes an uninstaller at
`~/.local/share/open-computer-history/runtime/scripts/uninstall-local.sh`.
Run the installed diagnostic command with
`node ~/.local/share/open-computer-history/runtime/bin/doctor.mjs`.

The app is ad-hoc signed for local development. Distribution to other users
requires an appropriate signing and notarization process outside this
repository's local installer. macOS privacy permissions are tied to the
installed executable and signing identity; a rebuild may require permission
review in System Settings.

On a Command Line Tools installation with stale Swift module metadata,
`package-macos-app.sh` first attempts a fresh SwiftPM build and then uses a
scoped direct Swift compile if the known toolchain diagnostic occurs. The
fallback does not modify `/Library` and does not replace Swift package tests.
