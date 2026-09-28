import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalISO, stampSummaryTimeZone, summaryTimeZone, withLocalTimestamp } from "../src/time.ts";
import { formatDay, groupEntries } from "../views/computer-history/time.ts";

test("local ISO retains the instant across zones, dates, and fractional offsets", () => {
  const instant = "2026-09-28T06:33:41.123Z";
  assert.equal(formatLocalISO(instant, "Asia/Shanghai"), "2026-09-28T14:33:41.123+08:00");
  assert.equal(formatLocalISO("2026-09-28T18:33:41Z", "Asia/Shanghai"), "2026-09-29T02:33:41.000+08:00");
  assert.equal(formatLocalISO(instant, "UTC"), "2026-09-28T06:33:41.123+00:00");
  assert.equal(formatLocalISO(instant, "Asia/Kolkata"), "2026-09-28T12:03:41.123+05:30");
  assert.equal(formatLocalISO(instant, "Asia/Kathmandu"), "2026-09-28T12:18:41.123+05:45");
  assert.equal(new Date(formatLocalISO(instant, "Asia/Kathmandu")).toISOString(), instant);
});

test("DST spring gap and repeated fall hour retain distinct offsets", () => {
  assert.equal(formatLocalISO("2026-03-08T06:59:00Z", "America/New_York"), "2026-03-08T01:59:00.000-05:00");
  assert.equal(formatLocalISO("2026-03-08T07:00:00Z", "America/New_York"), "2026-03-08T03:00:00.000-04:00");
  assert.equal(formatLocalISO("2026-11-01T05:30:00Z", "America/New_York"), "2026-11-01T01:30:00.000-04:00");
  assert.equal(formatLocalISO("2026-11-01T06:30:00Z", "America/New_York"), "2026-11-01T01:30:00.000-05:00");
});

test("event presentation preserves UTC and skips invalid or absent timestamps", () => {
  assert.deepEqual(withLocalTimestamp({ timestamp: "2026-09-28T06:33:41Z", kind: "window.changed" }, "Asia/Shanghai"), {
    timestamp: "2026-09-28T06:33:41Z",
    localTimestamp: "2026-09-28T14:33:41.000+08:00",
    kind: "window.changed",
  });
  assert.deepEqual(withLocalTimestamp({ timestamp: "garbage" }, "UTC"), { timestamp: "garbage" });
  assert.deepEqual(withLocalTimestamp({ kind: "mouse.click" }, "UTC"), { kind: "mouse.click" });
});

test("summary metadata is sourced only from frontmatter and preserves literal dollar text", () => {
  const markdown = "---\ntitle: $& $' $`\ntimeZone: Wrong/Zone\ndescription: Cost $5\n---\nBody timeZone: UTC $& $' $`";
  assert.equal(summaryTimeZone(markdown), null);
  const stamped = stampSummaryTimeZone(markdown, "Asia/Shanghai");
  assert.equal(summaryTimeZone(stamped), "Asia/Shanghai");
  assert.equal(stamped.match(/^timeZone:/gmu)?.length, 1);
  assert.match(stamped, /title: \$& \$' \$`/u);
  assert.match(stamped, /Body timeZone: UTC \$& \$' \$`/u);
  assert.equal(summaryTimeZone("---\ntitle: Old\n---\nBody\ntimeZone: UTC"), null);
  assert.equal(summaryTimeZone("---\ntimeZone: 'America/New_York'\n---\nBody"), "America/New_York");
});

test("view groups days in the response zone across midnight and DST", () => {
  const now = new Date("2026-09-28T01:00:00Z");
  const entries = [{ start: "2026-09-27T16:30:00Z" }, { start: "2026-09-27T15:30:00Z" }];
  assert.deepEqual(groupEntries(entries, "Asia/Shanghai", now).map(([label]) => label), ["Today", "Yesterday"]);
  assert.equal(formatDay("2026-03-07T06:00:00Z", "America/New_York", new Date("2026-03-09T03:00:00Z")), "Yesterday");
});
