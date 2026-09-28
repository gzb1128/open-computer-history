import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTimeline } from "../src/timeline.ts";

test("timeline retains UTC intervals and identifies old versus zoned prose", async () => {
  const home = await mkdtemp(join(tmpdir(), "open-history-timeline-zone-"));
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  await writeFile(join(home, "config.json"), '{"timeZone":"Asia/Shanghai"}\n');
  const memories = join(home, "memories", "resources");
  await mkdir(memories, { recursive: true });
  const start = new Date(Math.floor(Date.now() / 600_000) * 600_000 - 1_200_000);
  const prefix = start.toISOString().replace(/:/gu, "-").replace(/\.\d{3}Z$/u, "Z");
  await writeFile(join(memories, `${prefix}-old1-10min-activity.md`), "---\ntitle: Old\ndescription: At 06:20\n---\nBody\n");
  await writeFile(join(memories, `${prefix}-new1-10min-activity.md`), "---\ntimeZone: America/New_York\ntitle: New\ndescription: At 02:20\n---\nBody\n");

  const result = await loadTimeline(1);
  assert.equal(result.timeZone, "Asia/Shanghai");
  assert.equal(result.entryCount, 2);
  const old = result.entries.find((entry) => entry.title === "Old")!;
  const current = result.entries.find((entry) => entry.title === "New")!;
  assert.equal(old.start, start.toISOString());
  assert.equal(old.end, new Date(start.getTime() + 600_000).toISOString());
  assert.equal(new Date(old.localStart).toISOString(), old.start);
  assert.equal(new Date(old.localEnd).toISOString(), old.end);
  assert.equal(old.summaryTimeZone, null);
  assert.equal(current.summaryTimeZone, "America/New_York");
});
