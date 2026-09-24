import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeInterval } from "../src/summarizer.ts";

async function eventFixture() {
  const home = await mkdtemp(join(tmpdir(), "open-history-summary-test-"));
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  const segment = join(home, "segments", "fixture");
  await mkdir(segment, { recursive: true });
  // Anchor the window to now. `summarizeInterval` counts events through
  // `readRecentEvents`, which also applies a 48-hour lookback, so a hardcoded
  // past date silently ages out of the fixture and reports "no events".
  const end = new Date(Math.floor(Date.now() / 600_000) * 600_000);
  const start = new Date(end.getTime() - 600_000);
  await writeFile(
    join(segment, "events.jsonl"),
    `${JSON.stringify({
      id: 1,
      timestamp: new Date(start.getTime() + 60_000).toISOString(),
      kind: "window.changed",
      app: {
        name: "Editor",
        secureInput: false,
        bundleIdentifier: "com.example.Editor",
      },
      window: { title: "Planning notes", windowID: 7 },
    })}\n`,
  );
  return { home, start, end };
}

const memoryMarkdown = [
  "---",
  "title: Planning notes",
  "description: You reviewed planning notes in an editor.",
  "applications: [com.example.Editor]",
  "---",
  "## Memory summary",
  "The user reviewed planning notes.",
  "### Relevant prior context",
  "No relevant prior context established.",
  "### Important non-obvious context about the user",
  "No additional context established.",
  "## Recording summary",
  "The editor window was active.",
  "## Citations",
  "- fixture/events.jsonl",
];

/**
 * A stand-in Codex binary: records its argv and writes `memoryMarkdown` to the
 * path following `-o`, which is how the summarizer reads the result back.
 */
function fakeCodexScript(argsPath: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${argsPath}"`,
    'out=""',
    'previous=""',
    'for arg in "$@"; do',
    '  if [ "$previous" = "-o" ]; then out="$arg"; fi',
    '  previous="$arg"',
    "done",
    "cat > \"$out\" <<'EOF'",
    ...memoryMarkdown,
    "EOF",
    "",
  ].join("\n");
}

test("summarizer writes a validated memory through the configured Codex binary", async () => {
  const { home, start, end } = await eventFixture();
  const fake = join(home, "fake-codex-success.sh");
  await writeFile(fake, fakeCodexScript(join(home, "args.txt")));
  await chmod(fake, 0o755);
  process.env.OPEN_HISTORY_CODEX_BIN = fake;

  const result = await summarizeInterval({ start, end, level: "10min" });
  assert.equal(result.eventCount, 1);
  assert.match(await readFile(result.memoryPath, "utf8"), /Planning notes/u);
});

test("summarizer passes the configured model to the Codex binary", async () => {
  const { home, start, end } = await eventFixture();
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify({ summaryModel: "gpt-5.6-luna" })}\n`,
  );
  const argsPath = join(home, "args.txt");
  const fake = join(home, "fake-codex-model.sh");
  await writeFile(fake, fakeCodexScript(argsPath));
  await chmod(fake, 0o755);
  process.env.OPEN_HISTORY_CODEX_BIN = fake;

  await summarizeInterval({ start, end, level: "10min" });

  const argv = (await readFile(argsPath, "utf8")).split("\n");
  const index = argv.indexOf("-m");
  assert.notEqual(index, -1);
  assert.equal(argv[index + 1], "gpt-5.6-luna");
});

test("summarizer omits -m when no model is configured", async () => {
  const { home, start, end } = await eventFixture();
  const argsPath = join(home, "args.txt");
  const fake = join(home, "fake-codex-default.sh");
  await writeFile(fake, fakeCodexScript(argsPath));
  await chmod(fake, 0o755);
  process.env.OPEN_HISTORY_CODEX_BIN = fake;

  await summarizeInterval({ start, end, level: "10min" });

  const argv = (await readFile(argsPath, "utf8")).split("\n");
  assert.equal(argv.indexOf("-m"), -1);
});

test("summarizer circuit prevents immediate retry storms", async () => {
  const { home, start, end } = await eventFixture();
  const countPath = join(home, "invocations.txt");
  const fake = join(home, "fake-codex-failure.sh");
  await writeFile(
    fake,
    `#!/bin/sh
echo called >> "${countPath}"
echo backend-unavailable >&2
exit 1
`,
  );
  await chmod(fake, 0o755);
  process.env.OPEN_HISTORY_CODEX_BIN = fake;

  await assert.rejects(
    summarizeInterval({ start, end, level: "10min" }),
    /backend-unavailable/u,
  );
  await assert.rejects(
    summarizeInterval({ start, end, level: "10min" }),
    /circuit is open/u,
  );
  const invocations = (await readFile(countPath, "utf8")).trim().split(/\n/u);
  assert.equal(invocations.length, 1);
});
