import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "open-history-test-"));
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  const segment = join(home, "segments", "fixture");
  await mkdir(segment, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(segment, "events.jsonl"),
    [
      JSON.stringify({
        timestamp: now,
        kind: "window.changed",
        app: { bundleIdentifier: "com.example.Editor" },
        window: { title: "Launch plan" },
        keyboard: { text: "sensitive text" },
        ax: { mode: "fullTree", text: "sensitive tree" },
      }),
      JSON.stringify({
        timestamp: now,
        kind: "mouse.click",
        app: { bundleIdentifier: "com.example.Editor" },
      }),
    ].join("\n") + "\n",
  );
  return home;
}

test("recent events redact content by default", async () => {
  await fixture();
  const { readRecentEvents } = await import("../src/history-store.ts");
  const events = await readRecentEvents({
    hours: 1,
    limit: 10,
    includeText: false,
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.keyboard?.text, undefined);
  assert.equal("ax" in events[0]!, false);
});

test("search finds window titles but keeps captured text redacted", async () => {
  await fixture();
  const { searchHistory } = await import("../src/history-store.ts");
  const result = await searchHistory({
    query: "Launch plan",
    hours: 1,
    limit: 10,
    includeText: false,
  });
  assert.equal(result.eventMatches.length, 1);
  assert.equal(result.eventMatches[0]!.keyboard?.text, undefined);
});

test("search returns the newest matching memories first", async () => {
  const home = await newHistoryHome();
  const memories = join(home, "memories", "resources");
  await mkdir(memories, { recursive: true });
  for (const [name, title] of [
    ["2026-11-17T00-00-00Z-old-10min-activity.md", "Oldest"],
    ["2026-11-17T01-00-00Z-mid-10min-activity.md", "Middle"],
    ["2026-11-17T02-00-00Z-new-10min-activity.md", "Newest"],
  ] as const) {
    await writeFile(
      join(memories, name),
      `---\ntitle: ${title}\n---\nPlanning notes\n`,
    );
  }

  const { searchHistory } = await import("../src/history-store.ts");
  const result = await searchHistory({
    query: "Planning",
    hours: 1,
    limit: 2,
    includeText: false,
  });
  assert.deepEqual(
    result.memoryMatches.map((match) => match.title),
    ["Newest", "Middle"],
  );
});

test("recent queries scan only metadata-overlapping segments and return newest events in order", async () => {
  const home = await newHistoryHome();
  const now = Date.now();
  await writeSegment(home, "old", {
    start: now - 3 * 3_600_000,
    end: now - 2 * 3_600_000,
    events: [
      recentEvent(1, now - 150 * 60_000),
      recentEvent(2, now - 140 * 60_000),
    ],
  });
  const newEvents = join(
    await writeSegment(home, "new", {
      start: now - 60 * 60_000,
      end: now - 1_000,
      events: [
        recentEvent(3, now - 50 * 60_000),
        recentEvent(4, now - 40 * 60_000),
        recentEvent(5, now - 30 * 60_000),
      ],
    }),
    "events.jsonl",
  );

  const { eventFilesForInterval, readRecentEvents } = await import(
    "../src/history-store.ts"
  );
  assert.deepEqual(
    await eventFilesForInterval(
      new Date(now - 60 * 60_000),
      new Date(now),
    ),
    [newEvents],
    "the old segment is excluded from its metadata time range",
  );
  const events = await readRecentEvents({
    hours: 1,
    limit: 3,
    includeText: false,
  });
  assert.deepEqual(events.map((event) => event.id), [5, 4, 3]);
});

test("oversized accessibility payloads are bounded and marked as truncated", async () => {
  const home = await newHistoryHome();
  const now = Date.now();
  const segment = await writeSegment(home, "oversized", {
    start: now - 60_000,
    end: now - 1_000,
    events: [{
      id: 1,
      timestamp: new Date(now - 30_000).toISOString(),
      kind: "accessibility.changed",
      app: { bundleIdentifier: "com.example.Editor", name: "Editor" },
      ax: { mode: "fullTree", text: "x".repeat(200_000) },
    }],
  });
  await utimes(
    join(segment, "events.jsonl"),
    new Date(now - 20_000),
    new Date(now - 20_000),
  );

  const { readRecentEvents } = await import("../src/history-store.ts");
  const [event] = await readRecentEvents({
    hours: 1,
    limit: 1,
    includeText: true,
    maxEventBytes: 2_048,
  });
  assert.equal(event?.truncated, true);
  assert.equal(event?.ax, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") <= 2_048);
});

test("status trusts fresh completed metadata and recomputes after streamed rewrites", async () => {
  const home = await newHistoryHome();
  const now = Date.now();
  const segment = await writeSegment(home, "status", {
    start: now - 60_000,
    end: now - 1_000,
    events: [recentEvent(1, now - 30_000)],
    metadataEventCount: 7,
    metadataSuppressedCount: 3,
  });
  await utimes(
    join(segment, "events.jsonl"),
    new Date(now - 20_000),
    new Date(now - 20_000),
  );

  const { clearHistoryRequest, getHistoryStatus } = await import(
    "../src/history-store.ts"
  );
  const metadataStatus = await getHistoryStatus();
  assert.equal(metadataStatus.eventCount, 7);
  assert.equal(metadataStatus.suppressedEventCount, 3);
  assert.equal(
    metadataStatus.newestEventAt,
    new Date(now - 30_000).toISOString(),
    "newestEventAt comes from the event stream rather than segment close time",
  );
  await clearHistoryRequest({ scope: "last_hour" });
  const rewrittenStatus = await getHistoryStatus();
  assert.equal(
    rewrittenStatus.eventCount,
    0,
    "a rewritten event file invalidates its pre-rewrite metadata count",
  );
  assert.equal(rewrittenStatus.newestEventAt, null);
});

test("byte budgets preserve newest-event order and report aggregate truncation", async () => {
  const { boundItemsToByteBudget } = await import("../src/history-store.ts");
  const events = Array.from({ length: 10 }, (_, id) => ({
    id,
    payload: "x".repeat(900),
  }));
  const result = boundItemsToByteBudget(events, 2_500);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.items.map((event) => event.id),
    [0, 1],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result.items), "utf8") <= 2_500);
});

test("application-session clearing removes only the latest contiguous app session", async () => {
  const home = await mkdtemp(join(tmpdir(), "open-history-session-test-"));
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  const segment = join(home, "segments", "fixture");
  await mkdir(segment, { recursive: true });
  const now = Date.now();
  const event = (
    id: number,
    ageSeconds: number,
    bundleIdentifier: string,
  ) => ({
    id,
    timestamp: new Date(now - ageSeconds * 1000).toISOString(),
    kind: "window.changed",
    app: { bundleIdentifier, secureInput: false },
  });
  await writeFile(
    join(segment, "events.jsonl"),
    [
      event(1, 40, "com.example.Editor"),
      event(2, 30, "com.example.Browser"),
      event(3, 20, "com.example.Editor"),
      event(4, 10, "com.example.Editor"),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  await writeFile(join(segment, "suppressed.jsonl"), "");

  const { clearHistoryRequest } = await import("../src/history-store.ts");
  const result = await clearHistoryRequest({
    scope: "application_session",
    bundleIdentifier: "com.example.Editor",
  });
  assert.equal(result.deletedEventCount, 2);
  const remaining = await readFile(join(segment, "events.jsonl"), "utf8");
  assert.match(remaining, /"id":1/u);
  assert.match(remaining, /"id":2/u);
  assert.doesNotMatch(remaining, /"id":3/u);
  assert.doesNotMatch(remaining, /"id":4/u);
});

async function newHistoryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "open-history-store-test-"));
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  return home;
}

async function writeSegment(
  home: string,
  name: string,
  options: {
    start: number;
    end: number;
    events: Record<string, unknown>[];
    metadataEventCount?: number;
    metadataSuppressedCount?: number;
  },
): Promise<string> {
  const segment = join(home, "segments", name);
  await mkdir(segment, { recursive: true });
  await writeFile(
    join(segment, "events.jsonl"),
    options.events.map(JSON.stringify).join("\n") + "\n",
  );
  await writeFile(
    join(segment, "metadata.json"),
    JSON.stringify({
      id: name,
      eventsPath: join(segment, "events.jsonl"),
      startedAt: new Date(options.start).toISOString(),
      endedAt: new Date(options.end).toISOString(),
      endReason: "test",
      eventCount: options.metadataEventCount ?? options.events.length,
      suppressedEventCount: options.metadataSuppressedCount ?? 0,
    }),
  );
  return segment;
}

function recentEvent(id: number, timestamp: number) {
  return {
    id,
    timestamp: new Date(timestamp).toISOString(),
    kind: "window.changed",
    app: { bundleIdentifier: "com.example.Editor" },
  };
}
