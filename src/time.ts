/** Render an instant in an IANA zone with an explicit numeric UTC offset. */
export function formatLocalISO(value: Date | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const field = (type: string) => parts.find((part) => part.type === type)!.value;
  const year = field("year");
  const month = field("month");
  const day = field("day");
  const hour = field("hour");
  const minute = field("minute");
  const second = field("second");
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  const localAsUTC = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +milliseconds);
  const offsetMinutes = Math.round((localAsUTC - date.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}${offset}`;
}

/** Add a display field only when a source event has an unambiguous timestamp. */
export function withLocalTimestamp<T extends { timestamp?: unknown }>(event: T, timeZone: string): T & { localTimestamp?: string } {
  const value = event.timestamp;
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    return { ...event };
  }
  return { ...event, localTimestamp: formatLocalISO(value, timeZone) };
}

/** Old memories have no trustworthy source zone for times in their prose. */
export function summaryTimeZone(markdown: string): string | null {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  const zone = frontmatter?.match(/^timeZone:\s*([^\r\n]+)$/mu)?.[1]?.trim().replace(/^(["'])(.*)\1$/u, "$2");
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function stampSummaryTimeZone(markdown: string, timeZone: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) throw new Error("Codex produced an invalid memory: missing frontmatter");
  const fields = match[1]!.replace(/^timeZone:.*(?:\r?\n|$)/gmu, "");
  return markdown.replace(match[0], () => `---\ntimeZone: ${timeZone}\n${fields}\n---`);
}
