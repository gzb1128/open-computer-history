import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { summaryTimeZone } from "./time.js";

export type HistoryEvent = Record<string, unknown> & {
  timestamp?: string;
  kind?: string;
  type?: string;
  app?: { bundleIdentifier?: string; name?: string };
  application?: { bundleIdentifier?: string; name?: string };
  window?: { title?: string; url?: string; urlDomain?: string };
  keyboard?: { text?: string; keyEquivalent?: string; modifiers?: string[] };
  selection?: { selectedText?: string };
  ax?: { mode?: string; text?: string };
};

export function historyHome(): string {
  return resolve(
    process.env.OPEN_COMPUTER_HISTORY_HOME ??
      join(homedir(), ".open-codex-computer-history"),
  );
}

export async function getHistoryStatus() {
  const home = historyHome();
  const eventFiles = await findNamedFiles(join(home, "segments"), "events.jsonl");
  const suppressedFiles = await findNamedFiles(
    join(home, "segments"),
    "suppressed.jsonl",
  );
  const memoryFiles = await findFiles(join(home, "memories", "resources"), ".md");
  const events = await readJSONLFiles(eventFiles);

  return {
    home,
    segmentCount: eventFiles.length,
    eventCount: events.length,
    suppressedEventCount: (await readJSONLFiles(suppressedFiles)).length,
    memoryCount: memoryFiles.length,
    newestEventAt:
      events
        .map((event) => event.timestamp)
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1) ?? null,
  };
}

export async function readRecentEvents(options: {
  hours: number;
  limit: number;
  eventTypes?: string[];
  applications?: string[];
  includeText: boolean;
}): Promise<HistoryEvent[]> {
  const cutoff = Date.now() - options.hours * 60 * 60 * 1000;
  const files = await findNamedFiles(
    join(historyHome(), "segments"),
    "events.jsonl",
  );
  const events = await readJSONLFiles(files);
  return events
    .filter((event) => eventTime(event) >= cutoff)
    .filter(
      (event) =>
        !options.eventTypes?.length ||
        options.eventTypes.includes(String(event.kind ?? event.type)),
    )
    .filter(
      (event) =>
        !options.applications?.length ||
        options.applications.includes(
          String(
            event.app?.bundleIdentifier ??
              event.application?.bundleIdentifier ??
              "",
          ),
        ),
    )
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, options.limit)
    .map((event) => sanitizeEvent(event, options.includeText));
}

export async function searchHistory(options: {
  query: string;
  hours: number;
  limit: number;
  includeText: boolean;
}) {
  const query = options.query.toLocaleLowerCase();
  const events = await readRecentEvents({
    hours: options.hours,
    limit: 10_000,
    includeText: true,
  });
  const eventMatches = events
    .filter((event) => JSON.stringify(event).toLocaleLowerCase().includes(query))
    .slice(0, options.limit)
    .map((event) => sanitizeEvent(event, options.includeText));

  const memoryFiles = await findFiles(
    join(historyHome(), "memories", "resources"),
    ".md",
  );
  const memoryMatches = [];
  for (const path of memoryFiles) {
    const markdown = await readFile(path, "utf8");
    const index = markdown.toLocaleLowerCase().indexOf(query);
    if (index === -1) continue;
    memoryMatches.push({
      path,
      title: frontmatterValue(markdown, "title") ?? firstHeading(markdown),
      excerpt: excerptAround(markdown, index, query.length),
      summaryTimeZone: summaryTimeZone(markdown),
    });
    if (memoryMatches.length >= options.limit) break;
  }
  return { eventMatches, memoryMatches };
}

export async function clearHistory(
  scope: "last_10_minutes" | "last_hour" | "last_day" | "all",
) {
  return clearHistoryRequest({ scope });
}

export async function clearHistoryRequest(request: {
  scope:
    | "last_10_minutes"
    | "last_hour"
    | "last_day"
    | "today"
    | "interval"
    | "application_session"
    | "all";
  interval?: { start: Date; end: Date };
  bundleIdentifier?: string;
}) {
  const home = historyHome();
  const interval = await resolveClearInterval(request);

  let deletedEventCount = 0;
  const eventFiles = [
    ...(await findNamedFiles(join(home, "segments"), "events.jsonl")),
    ...(await findNamedFiles(join(home, "segments"), "suppressed.jsonl")),
  ];
  for (const file of eventFiles) {
    const lines = await readLines(file);
    const retained = [];
    for (const line of lines) {
      const event = parseJSONLine(line);
      const candidate =
        event && typeof event.event === "object"
          ? (event.event as HistoryEvent)
          : (event as HistoryEvent | null);
      if (candidate && shouldDeleteEvent(candidate, request, interval)) {
        deletedEventCount += 1;
      } else {
        retained.push(line);
      }
    }
    await writeFile(file, retained.length ? `${retained.join("\n")}\n` : "");
  }

  let deletedMemoryCount = 0;
  const memoryFiles = await findFiles(join(home, "memories", "resources"), ".md");
  for (const file of memoryFiles) {
    const modifiedAt = (await stat(file)).mtimeMs;
    if (
      request.scope === "all" ||
      (interval &&
        modifiedAt >= interval.start.getTime() &&
        modifiedAt < interval.end.getTime())
    ) {
      await rm(file, { force: true });
      deletedMemoryCount += 1;
    }
  }
  return { deletedEventCount, deletedMemoryCount };
}

async function resolveClearInterval(request: {
  scope: string;
  interval?: { start: Date; end: Date };
  bundleIdentifier?: string;
}): Promise<{ start: Date; end: Date } | null> {
  const now = new Date();
  switch (request.scope) {
    case "all":
      return null;
    case "last_10_minutes":
      return { start: new Date(now.getTime() - 600_000), end: now };
    case "last_hour":
      return { start: new Date(now.getTime() - 3_600_000), end: now };
    case "last_day":
      return { start: new Date(now.getTime() - 86_400_000), end: now };
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end: now };
    }
    case "interval":
      if (!request.interval || request.interval.start >= request.interval.end) {
        throw new Error("Clear-history interval requires start before end.");
      }
      return request.interval;
    case "application_session":
      return latestApplicationSession(request.bundleIdentifier);
    default:
      throw new Error(`Unsupported clear scope: ${request.scope}`);
  }
}

async function latestApplicationSession(
  requestedBundleIdentifier?: string,
): Promise<{ start: Date; end: Date } | null> {
  const files = await findNamedFiles(
    join(historyHome(), "segments"),
    "events.jsonl",
  );
  const events = (await readJSONLFiles(files))
    .filter((event) => eventTime(event) > 0)
    .sort((a, b) => eventTime(a) - eventTime(b));

  const sessions: Array<{
    bundleIdentifier: string;
    start: Date;
    end: Date;
  }> = [];
  let current:
    | { bundleIdentifier: string; start: Date; end: Date }
    | undefined;
  for (const event of events) {
    const bundleIdentifier =
      event.app?.bundleIdentifier ?? event.application?.bundleIdentifier;
    if (!bundleIdentifier) continue;
    const timestamp = new Date(eventTime(event));
    if (!current || current.bundleIdentifier !== bundleIdentifier) {
      if (current) sessions.push(current);
      current = { bundleIdentifier, start: timestamp, end: timestamp };
    } else {
      current.end = timestamp;
    }
  }
  if (current) sessions.push(current);
  const selected = [...sessions]
    .reverse()
    .find(
      (session) =>
        !requestedBundleIdentifier ||
        session.bundleIdentifier === requestedBundleIdentifier,
    );
  return selected
    ? {
        start: selected.start,
        end: new Date(selected.end.getTime() + 1),
      }
    : null;
}

function shouldDeleteEvent(
  event: HistoryEvent,
  request: { scope: string; bundleIdentifier?: string },
  interval: { start: Date; end: Date } | null,
): boolean {
  if (request.scope === "all") return true;
  if (!interval) return false;
  const timestamp = eventTime(event);
  if (timestamp < interval.start.getTime() || timestamp >= interval.end.getTime()) {
    return false;
  }
  if (request.scope !== "application_session" || !request.bundleIdentifier) {
    return true;
  }
  return (
    event.app?.bundleIdentifier === request.bundleIdentifier ||
    event.application?.bundleIdentifier === request.bundleIdentifier
  );
}

export async function sourceEventFiles(minutes: number): Promise<string[]> {
  return eventFilesForInterval(
    new Date(Date.now() - minutes * 60 * 1000),
    new Date(),
  );
}

export async function eventFilesForInterval(
  start: Date,
  end: Date,
): Promise<string[]> {
  const files = await findNamedFiles(
    join(historyHome(), "segments"),
    "events.jsonl",
  );
  const selected = [];
  for (const file of files) {
    const events = await readJSONLFiles([file]);
    if (
      events.some((event) => {
        const timestamp = eventTime(event);
        return timestamp >= start.getTime() && timestamp < end.getTime();
      })
    ) {
      selected.push(file);
    }
  }
  return selected;
}

export async function countEventsSince(minutes: number): Promise<number> {
  return countEventsInInterval(
    new Date(Date.now() - minutes * 60 * 1000),
    new Date(),
  );
}

export async function countEventsInInterval(
  start: Date,
  end: Date,
): Promise<number> {
  const events = await readRecentEvents({
    hours: Math.max(48, (end.getTime() - start.getTime()) / 3_600_000),
    limit: 100_000,
    includeText: true,
  });
  return events.filter((event) => {
    const timestamp = eventTime(event);
    return timestamp >= start.getTime() && timestamp < end.getTime();
  }).length;
}

export async function memoryFilesForInterval(
  start: Date,
  end: Date,
  level: "10min" | "6h",
): Promise<string[]> {
  const files = await findFiles(join(historyHome(), "memories", "resources"), ".md");
  const marker = `-${level}-`;
  const selected = [];
  for (const file of files) {
    if (!file.includes(marker)) continue;
    const timestamp = memoryTimestamp(file) ?? (await stat(file)).mtimeMs;
    if (timestamp >= start.getTime() && timestamp < end.getTime()) {
      selected.push(file);
    }
  }
  return selected.sort();
}

function memoryTimestamp(file: string): number | null {
  const match = basename(file).match(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z/u,
  );
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJSONLFiles(files: string[]): Promise<HistoryEvent[]> {
  const output: HistoryEvent[] = [];
  for (const file of files) {
    for (const line of await readLines(file)) {
      const value = parseJSONLine(line);
      if (value) output.push(value as HistoryEvent);
    }
  }
  return output;
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function parseJSONLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function eventTime(event: HistoryEvent): number {
  const parsed = Date.parse(String(event.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeEvent(event: HistoryEvent, includeText: boolean): HistoryEvent {
  if (includeText) return event;
  const safe = structuredClone(event);
  if (safe.keyboard && typeof safe.keyboard === "object") {
    delete safe.keyboard.text;
  }
  if (safe.selection && typeof safe.selection === "object") {
    delete safe.selection.selectedText;
  }
  delete safe.ax;
  delete safe.text;
  delete safe.selectedText;
  delete safe.fullTree;
  delete safe.diffFromPrevious;
  return safe;
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  return walk(root, (path) => path.endsWith(`/${name}`));
}

async function findFiles(root: string, suffix: string): Promise<string[]> {
  return walk(root, (path) => path.endsWith(suffix));
}

async function walk(
  root: string,
  predicate: (path: string) => boolean,
): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path, predicate)));
    else if (predicate(path)) output.push(path);
  }
  return output.sort();
}

function frontmatterValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  return match?.[1]?.trim().replace(/^["']|["']$/gu, "") ?? null;
}

function firstHeading(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? "Computer History memory";
}

function excerptAround(markdown: string, index: number, length: number): string {
  const start = Math.max(0, index - 140);
  const end = Math.min(markdown.length, index + length + 220);
  return markdown.slice(start, end).replace(/\s+/gu, " ").trim();
}

export function memoryDirectory(): string {
  return join(historyHome(), "memories", "resources");
}

export function ensureParent(path: string): Promise<void> {
  return import("node:fs/promises").then(({ mkdir }) =>
    mkdir(dirname(path), { recursive: true }).then(() => undefined),
  );
}
