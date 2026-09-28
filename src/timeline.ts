import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { clearHistoryRequest, memoryDirectory } from "./history-store.js";
import { recorderStatus } from "./runtime-control.js";
import { getTimeZone } from "./settings.js";
import { formatLocalISO, summaryTimeZone } from "./time.js";

export interface TimelineEntry {
  id: string;
  title: string;
  description: string;
  applications: string[];
  start: string;
  end: string;
  localStart: string;
  localEnd: string;
  summaryTimeZone: string | null;
  level: "10min" | "6h";
  suggestion?: {
    type: "skill" | "automation";
    name: string;
    description: string;
  };
}

export async function loadTimeline(days: number) {
  const timeZone = await getTimeZone();
  const directory = memoryDirectory();
  let filenames: string[] = [];
  try {
    filenames = await readdir(directory);
  } catch {
    // An empty timeline is valid before the first summary.
  }
  const cutoff = Date.now() - days * 86_400_000;
  const entries: TimelineEntry[] = [];
  for (const filename of filenames.filter((name) => name.endsWith(".md"))) {
    const interval = intervalFromMemoryFilename(filename);
    if (!interval || interval.start.getTime() < cutoff) continue;
    const markdown = await readFile(join(directory, filename), "utf8");
    entries.push({
      id: filename,
      title: frontmatter(markdown, "title") ?? "Computer activity",
      description:
        frontmatter(markdown, "description") ?? "Activity summary unavailable.",
      applications: parseApplications(frontmatter(markdown, "applications")),
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
      localStart: formatLocalISO(interval.start, timeZone),
      localEnd: formatLocalISO(interval.end, timeZone),
      summaryTimeZone: summaryTimeZone(markdown),
      level: interval.level,
      ...(parseSuggestion(markdown)
        ? { suggestion: parseSuggestion(markdown)! }
        : {}),
    });
  }
  entries.sort((a, b) => b.start.localeCompare(a.start));
  return {
    timeZone,
    status: await recorderStatus(),
    entryCount: entries.length,
    entries,
  };
}

export async function deleteTimelineItem(id: string) {
  if (basename(id) !== id || !id.endsWith(".md")) {
    throw new Error("Invalid Computer History item id.");
  }
  const interval = intervalFromMemoryFilename(id);
  if (!interval) throw new Error("Unrecognized Computer History item.");
  await clearHistoryRequest({
    scope: "interval",
    interval: { start: interval.start, end: interval.end },
  });
  await rm(join(memoryDirectory(), id), { force: true });
  return { deleted: true, id };
}

export function intervalFromMemoryFilename(filename: string) {
  const match = filename.match(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z-[A-Za-z0-9]+-(10min|6h)-/u,
  );
  if (!match) return null;
  const start = new Date(
    `${match[1]}${match[2]}:${match[3]}:${match[4]}Z`,
  );
  const level = match[5] as "10min" | "6h";
  const duration = level === "10min" ? 600_000 : 21_600_000;
  return { start, end: new Date(start.getTime() + duration), level };
}

function frontmatter(markdown: string, key: string): string | null {
  return (
    markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"))?.[1]?.trim() ?? null
  );
}

function parseApplications(value: string | null): string[] {
  if (!value) return [];
  const inner = value.replace(/^\[/u, "").replace(/\]$/u, "");
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/gu, ""))
    .filter(Boolean);
}

function parseSuggestion(markdown: string): TimelineEntry["suggestion"] {
  const block = markdown.match(
    /^suggestion:\s*\n((?: {2}.+\n?){3,})/mu,
  )?.[1];
  if (!block) return undefined;
  const type = block.match(/^ {2}type:\s*(skill|automation)$/mu)?.[1] as
    | "skill"
    | "automation"
    | undefined;
  const name = block.match(/^ {2}name:\s*(.+)$/mu)?.[1]?.trim();
  const description = block
    .match(/^ {2}description:\s*(.+)$/mu)?.[1]
    ?.trim();
  return type && name && description ? { type, name, description } : undefined;
}
