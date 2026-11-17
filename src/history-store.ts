import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
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
  truncated?: true;
};

interface EventSegment {
  eventsPath: string;
  suppressedEventsPath: string;
  startedAt: Date;
  endedAt?: Date;
  eventCount?: number;
  suppressedEventCount?: number;
  eventsModifiedAt?: number;
  suppressedEventsModifiedAt?: number;
  metadataModifiedAt?: number;
}

interface SegmentMetadata {
  startedAt?: unknown;
  endedAt?: unknown;
  eventCount?: unknown;
  suppressedEventCount?: unknown;
}

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const MAX_CAPTURE_TEXT_CHARS = 16_384;
const AGGRESSIVE_CAPTURE_TEXT_CHARS = 2_048;

export function historyHome(): string {
  return resolve(
    process.env.OPEN_COMPUTER_HISTORY_HOME ??
      join(homedir(), ".open-codex-computer-history"),
  );
}

export async function getHistoryStatus() {
  const home = historyHome();
  const segments = await listEventSegments(home);
  const memoryFiles = await findFiles(join(home, "memories", "resources"), ".md");
  let eventCount = 0;
  let suppressedEventCount = 0;
  let newestEventAt: string | null = null;
  let newestCandidate = -1;
  let newestEventSegment: EventSegment | undefined;

  for (const segment of segments) {
    const eventStats = await segmentLineStats(segment, "eventsPath");
    const suppressedStats = await segmentLineStats(segment, "suppressedEventsPath");
    eventCount += eventStats.count;
    suppressedEventCount += suppressedStats.count;
    if (eventStats.count > 0) newestEventSegment = segment;
    if (eventStats.count > 0) {
      const candidate = eventStats.lastTimestamp ??
        segment.endedAt?.toISOString() ??
        segment.startedAt.toISOString();
      const candidateTime = Date.parse(candidate);
      if (Number.isFinite(candidateTime) && candidateTime > newestCandidate) {
        newestCandidate = candidateTime;
        newestEventAt = candidate;
      }
    }
  }
  if (newestEventSegment) {
    const lastTimestamp = await lastEventTimestamp(newestEventSegment.eventsPath);
    if (lastTimestamp) newestEventAt = lastTimestamp;
  }

  return {
    home,
    segmentCount: segments.length,
    eventCount,
    suppressedEventCount,
    memoryCount: memoryFiles.length,
    newestEventAt,
  };
}

export async function readRecentEvents(options: {
  hours: number;
  limit: number;
  eventTypes?: string[];
  applications?: string[];
  includeText: boolean;
  maxEventBytes?: number;
}): Promise<HistoryEvent[]> {
  const end = new Date();
  const start = new Date(end.getTime() - options.hours * 60 * 60 * 1000);
  return collectNewestMatchingEvents({
    start,
    end,
    limit: options.limit,
    maxEventBytes: options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
    includeText: options.includeText,
    matches(event) {
      const timestamp = eventTime(event);
      if (timestamp < start.getTime() || timestamp >= end.getTime()) return false;
      if (
        options.eventTypes?.length &&
        !options.eventTypes.includes(String(event.kind ?? event.type))
      ) {
        return false;
      }
      return (
        !options.applications?.length ||
        options.applications.includes(
          String(
            event.app?.bundleIdentifier ??
              event.application?.bundleIdentifier ??
              "",
          ),
        )
      );
    },
  });
}

export async function searchHistory(options: {
  query: string;
  hours: number;
  limit: number;
  includeText: boolean;
  maxEventBytes?: number;
}) {
  const query = options.query.toLocaleLowerCase();
  const end = new Date();
  const start = new Date(end.getTime() - options.hours * 60 * 60 * 1000);
  const eventMatches = await collectNewestMatchingEvents({
    start,
    end,
    limit: options.limit,
    maxEventBytes: options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
    includeText: options.includeText,
    prefilter(line) {
      return line.toLocaleLowerCase().includes(query);
    },
    matches(event) {
      const timestamp = eventTime(event);
      return (
        timestamp >= start.getTime() &&
        timestamp < end.getTime()
      );
    },
  });

  const memoryFiles = await findFiles(
    join(historyHome(), "memories", "resources"),
    ".md",
  );
  const memoryCandidates: Array<{
    path: string;
    timestamp: number;
    title: string;
    excerpt: string;
    summaryTimeZone: string | null;
  }> = [];
  for (const path of memoryFiles) {
    const markdown = await readFile(path, "utf8");
    const index = markdown.toLocaleLowerCase().indexOf(query);
    if (index === -1) continue;
    memoryCandidates.push({
      path,
      timestamp: memoryTimestamp(path) ?? (await stat(path)).mtimeMs,
      title: frontmatterValue(markdown, "title") ?? firstHeading(markdown),
      excerpt: excerptAround(markdown, index, query.length),
      summaryTimeZone: summaryTimeZone(markdown),
    });
  }
  const memoryMatches = memoryCandidates
    .sort((a, b) => b.timestamp - a.timestamp || b.path.localeCompare(a.path))
    .slice(0, options.limit)
    .map(({ path, title, excerpt, summaryTimeZone }) => ({
      path,
      title,
      excerpt,
      summaryTimeZone,
    }));
  return { eventMatches, memoryMatches };
}

export function boundItemsToByteBudget<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = jsonBytes(item) + (selected.length > 0 ? 1 : 0);
    if (bytes + itemBytes > maxBytes) break;
    selected.push(item);
    bytes += itemBytes;
  }
  return { items: selected, truncated: selected.length < items.length };
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
  const segments = await listEventSegments(home);
  const eventFiles = segments.flatMap((segment) => [
    segment.eventsPath,
    segment.suppressedEventsPath,
  ]);
  for (const file of eventFiles) {
    deletedEventCount += await rewriteJSONLFile(file, (line) => {
      const event = parseJSONLine(line);
      const candidate =
        event && typeof event.event === "object"
          ? (event.event as HistoryEvent)
          : (event as HistoryEvent | null);
      return candidate !== null && shouldDeleteEvent(candidate, request, interval);
    });
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
  const segments = await listEventSegments(historyHome());
  let current:
    | { bundleIdentifier: string; start: Date; end: Date }
    | undefined;
  let selected:
    | { bundleIdentifier: string; start: Date; end: Date }
    | undefined;

  const closeCurrent = () => {
    if (
      current &&
      (!requestedBundleIdentifier ||
        current.bundleIdentifier === requestedBundleIdentifier)
    ) {
      selected = current;
    }
  };

  for (const segment of segments) {
    for await (const line of readJSONLines(segment.eventsPath)) {
      const event = parseJSONLine(line);
      if (!event || eventTime(event) <= 0) continue;
      const bundleIdentifier =
        event.app?.bundleIdentifier ?? event.application?.bundleIdentifier;
      if (!bundleIdentifier) continue;
      const timestamp = new Date(eventTime(event));
      if (!current || current.bundleIdentifier !== bundleIdentifier) {
        closeCurrent();
        current = { bundleIdentifier, start: timestamp, end: timestamp };
      } else {
        current.end = timestamp;
      }
    }
  }
  closeCurrent();
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
  return (await segmentsForInterval(start, end)).map(
    (segment) => segment.eventsPath,
  );
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
  let count = 0;
  for (const segment of await segmentsForInterval(start, end)) {
    for await (const line of readJSONLines(segment.eventsPath)) {
      const event = parseJSONLine(line);
      if (!event) continue;
      const timestamp = eventTime(event);
      if (timestamp >= start.getTime() && timestamp < end.getTime()) count += 1;
    }
  }
  return count;
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

async function collectNewestMatchingEvents(options: {
  start: Date;
  end: Date;
  limit: number;
  includeText: boolean;
  maxEventBytes: number;
  prefilter?: (line: string) => boolean;
  matches: (event: HistoryEvent, line: string) => boolean;
}): Promise<HistoryEvent[]> {
  const segments = (await segmentsForInterval(options.start, options.end)).reverse();
  let selected: HistoryEvent[] = [];

  for (const segment of segments) {
    if (
      selected.length >= options.limit &&
      oldestEventTime(selected) > (segment.endedAt?.getTime() ?? options.end.getTime())
    ) {
      continue;
    }

    const ring: HistoryEvent[] = [];
    let cursor = 0;
    for await (const line of readJSONLines(segment.eventsPath)) {
      if (options.prefilter && !options.prefilter(line)) continue;
      const event = parseJSONLine(line);
      if (!event || !options.matches(event, line)) continue;
      const projected = projectEventForResponse(
        event,
        options.includeText,
        options.maxEventBytes,
      );
      if (ring.length < options.limit) {
        ring.push(projected);
      } else {
        ring[cursor] = projected;
        cursor = (cursor + 1) % options.limit;
      }
    }
    selected = newestEvents([...selected, ...ring], options.limit);
  }
  return selected;
}

async function segmentsForInterval(
  start: Date,
  end: Date,
): Promise<EventSegment[]> {
  return (await listEventSegments(historyHome())).filter((segment) => {
    const segmentEnd = segment.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return segment.startedAt.getTime() < end.getTime() && segmentEnd >= start.getTime();
  });
}

async function listEventSegments(home: string): Promise<EventSegment[]> {
  const root = join(home, "segments");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const segments: EventSegment[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const eventsPath = join(directory, "events.jsonl");
    let fileInfo;
    try {
      fileInfo = await stat(eventsPath);
    } catch {
      continue;
    }
    const metadata = await readSegmentMetadata(join(directory, "metadata.json"));
    const metadataStart = parseDate(metadata?.startedAt);
    const metadataEnd = parseDate(metadata?.endedAt);
    const namedStart = segmentDateFromName(entry.name);
    const suppressedInfo = await fileInfoOrUndefined(
      join(directory, "suppressed.jsonl"),
    );
    const metadataInfo = await fileInfoOrUndefined(
      join(directory, "metadata.json"),
    );
    segments.push({
      eventsPath,
      suppressedEventsPath: join(directory, "suppressed.jsonl"),
      startedAt: metadataStart ?? namedStart ?? new Date(0),
      endedAt: metadata
        ? metadataEnd
        : namedStart
          ? new Date(fileInfo.mtimeMs + 1_000)
          : undefined,
      eventCount: finiteCount(metadata?.eventCount),
      suppressedEventCount: finiteCount(metadata?.suppressedEventCount),
      eventsModifiedAt: fileInfo.mtimeMs,
      suppressedEventsModifiedAt: suppressedInfo?.mtimeMs,
      metadataModifiedAt: metadataInfo?.mtimeMs,
    });
  }
  return segments.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

async function readSegmentMetadata(path: string): Promise<SegmentMetadata | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null
      ? (value as SegmentMetadata)
      : null;
  } catch {
    return null;
  }
}

async function segmentLineStats(
  segment: EventSegment,
  key: "eventsPath" | "suppressedEventsPath",
): Promise<{ count: number; lastTimestamp: string | null }> {
  const completed = segment.endedAt !== undefined;
  const metadataCount = key === "eventsPath"
    ? segment.eventCount
    : segment.suppressedEventCount;
  const modifiedAt = key === "eventsPath"
    ? segment.eventsModifiedAt
    : segment.suppressedEventsModifiedAt;
  const metadataIsFresh =
    segment.metadataModifiedAt !== undefined &&
    (modifiedAt === undefined || segment.metadataModifiedAt > modifiedAt);
  if (completed && metadataCount !== undefined && metadataIsFresh) {
    return { count: metadataCount, lastTimestamp: null };
  }

  let count = 0;
  let lastTimestamp: string | null = null;
  for await (const line of readJSONLines(segment[key])) {
    count += 1;
    const match = line.match(/"timestamp"\s*:\s*"([^"]+)"/u);
    if (match && Number.isFinite(Date.parse(match[1]!))) {
      lastTimestamp = match[1]!;
    }
  }
  return { count, lastTimestamp };
}

async function lastEventTimestamp(path: string): Promise<string | null> {
  let lastTimestamp: string | null = null;
  for await (const line of readJSONLines(path)) {
    const match = line.match(/"timestamp"\s*:\s*"([^"]+)"/u);
    if (match && Number.isFinite(Date.parse(match[1]!))) {
      lastTimestamp = match[1]!;
    }
  }
  return lastTimestamp;
}

async function rewriteJSONLFile(
  path: string,
  shouldDelete: (line: string) => boolean,
): Promise<number> {
  try {
    await stat(path);
  } catch {
    return 0;
  }

  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const output = createWriteStream(temporaryPath, { encoding: "utf8" });
  let deleted = 0;
  try {
    for await (const line of readJSONLines(path)) {
      if (shouldDelete(line)) {
        deleted += 1;
      } else if (!output.write(`${line}\n`)) {
        await once(output, "drain");
      }
    }
    output.end();
    await finished(output);
    if (deleted === 0) {
      await rm(temporaryPath, { force: true });
      return 0;
    }
    await rename(temporaryPath, path);
    return deleted;
  } catch (error) {
    output.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function* readJSONLines(path: string): AsyncGenerator<string> {
  let input;
  try {
    input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim().length > 0) yield line;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return;
    }
    throw error;
  }
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function segmentDateFromName(name: string): Date | undefined {
  const match = name.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z/u);
  if (!match) return undefined;
  const parsed = new Date(
    `${match[1]}${match[2]}:${match[3]}:${match[4]}Z`,
  );
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

async function fileInfoOrUndefined(
  path: string,
): Promise<{ mtimeMs: number } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function parseJSONLine(line: string): HistoryEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as HistoryEvent)
      : null;
  } catch {
    return null;
  }
}

function eventTime(event: HistoryEvent): number {
  const parsed = Date.parse(String(event.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function oldestEventTime(events: HistoryEvent[]): number {
  return Math.min(...events.map(eventTime));
}

function newestEvents(events: HistoryEvent[], limit: number): HistoryEvent[] {
  return events
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, limit);
}

function projectEventForResponse(
  event: HistoryEvent,
  includeText: boolean,
  maxBytes: number,
): HistoryEvent {
  const projected = event;
  if (!includeText) {
    removeTextPayload(projected);
    if (jsonBytes(projected) > maxBytes) {
      return compactEventForResponse(projected, maxBytes);
    }
  } else {
    const state = { truncated: false };
    boundStringsAndArrays(projected, MAX_CAPTURE_TEXT_CHARS, 1_000, state);
    if (jsonBytes(projected) > maxBytes) {
      boundStringsAndArrays(
        projected,
        AGGRESSIVE_CAPTURE_TEXT_CHARS,
        64,
        state,
      );
    }
    if (jsonBytes(projected) > maxBytes) {
      removeTextPayload(projected);
      state.truncated = true;
    }
    if (jsonBytes(projected) > maxBytes) {
      return compactEventForResponse(projected, maxBytes);
    }
    if (state.truncated) projected.truncated = true;
  }
  return projected;
}

function compactEventForResponse(
  event: HistoryEvent,
  maxBytes: number,
): HistoryEvent {
  for (const [depth, stringLimit, arrayLimit] of [
    [4, 256, 16],
    [2, 64, 8],
    [1, 16, 0],
  ] as const) {
    const compact: HistoryEvent = {};
    for (const key of [
      "id",
      "timestamp",
      "kind",
      "type",
      "app",
      "application",
      "window",
      "mouse",
      "keyboard",
      "selection",
      "diagnostic",
    ]) {
      if (!(key in event)) continue;
      compact[key] = boundedClone(
        event[key],
        0,
        depth,
        stringLimit,
        arrayLimit,
      );
    }
    compact.truncated = true;
    if (jsonBytes(compact) <= maxBytes) return compact;
  }
  const minimal: HistoryEvent = { truncated: true };
  for (const key of ["id", "timestamp", "kind", "type"]) {
    if (!(key in event)) continue;
    minimal[key] = boundedClone(event[key], 0, 1, 16, 0);
  }
  return minimal;
}

function boundedClone(
  value: unknown,
  depth: number,
  maxDepth: number,
  stringLimit: number,
  arrayLimit: number,
): unknown {
  if (typeof value === "string") {
    return value.length > stringLimit
      ? `${value.slice(0, stringLimit)}\n[truncated]`
      : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= maxDepth) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, arrayLimit)
      .map((item) =>
        boundedClone(item, depth + 1, maxDepth, stringLimit, arrayLimit)
      );
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = boundedClone(
      child,
      depth + 1,
      maxDepth,
      stringLimit,
      arrayLimit,
    );
  }
  return output;
}

function removeTextPayload(event: HistoryEvent): void {
  if (event.keyboard && typeof event.keyboard === "object") {
    delete event.keyboard.text;
  }
  if (event.selection && typeof event.selection === "object") {
    delete event.selection.selectedText;
  }
  delete event.ax;
  delete event.text;
  delete event.selectedText;
  delete event.fullTree;
  delete event.diffFromPrevious;
}

function boundStringsAndArrays(
  value: unknown,
  stringLimit: number,
  arrayLimit: number,
  state: { truncated: boolean },
): void {
  if (Array.isArray(value)) {
    if (value.length > arrayLimit) {
      value.splice(arrayLimit);
      state.truncated = true;
    }
    for (const item of value) {
      boundStringsAndArrays(item, stringLimit, arrayLimit, state);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === "string" && child.length > stringLimit) {
      object[key] = `${child.slice(0, stringLimit)}\n[truncated]`;
      state.truncated = true;
    } else if (child && typeof child === "object") {
      boundStringsAndArrays(child, stringLimit, arrayLimit, state);
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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
