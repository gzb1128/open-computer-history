export function groupEntries<T extends { start: string }>(entries: T[], timeZone: string, now = new Date()): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = dayKey(new Date(entry.start), timeZone);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([key, items]) => [formatDay(items[0]!.start, timeZone, now), items]);
}

export function formatDay(value: string, timeZone: string, now = new Date()): string {
  const date = new Date(value);
  const today = dayKey(now, timeZone);
  const day = dayKey(date, timeZone);
  if (day === today) return "Today";
  // Compare calendar dates in the requested zone, including DST days of 23 or 25 hours.
  const [year, month, dateOfMonth] = today.split("-").map(Number) as [number, number, number];
  const yesterday = new Date(Date.UTC(year, month - 1, dateOfMonth - 1));
  if (day === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(date);
}

export function formatTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

function dayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
