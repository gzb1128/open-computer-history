import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { historyHome } from "./history-store.js";

export const behaviorSchema = z.enum(["observe", "do_not_observe"]);
export const observationRuleSchema = z.object({
  scope: z.enum(["application", "url"]),
  bundleID: z.string().min(1).optional(),
  urlDomain: z.string().min(1).optional(),
});
export const observationSettingsSchema = z.object({
  defaultApplicationBehavior: behaviorSchema,
  defaultURLBehavior: behaviorSchema,
  allowlist: z.array(observationRuleSchema),
  blocklist: z.array(observationRuleSchema),
});
export const computerHistorySettingsSchema = z.object({
  observation: observationSettingsSchema,
  showMenuBarIcon: z.boolean(),
});

export type ComputerHistorySettings = z.infer<
  typeof computerHistorySettingsSchema
>;

const defaultSettings: ComputerHistorySettings = {
  observation: {
    defaultApplicationBehavior: "observe",
    defaultURLBehavior: "observe",
    allowlist: [],
    blocklist: [],
  },
  showMenuBarIcon: true,
};

function configPath(): string {
  return join(historyHome(), "config.json");
}

/**
 * Reads `config.json` as stored, without a schema.
 *
 * `config.json` also carries settings this module does not model — the CLI's
 * own `captureText` opt-out and the fork-local `summaryModel` — so callers that
 * write the file must start from these entries instead of a parsed subset.
 * A missing or unreadable file reads as empty.
 */
async function readComputerHistoryConfig(): Promise<
  Record<string, unknown>
> {
  try {
    const raw: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The model the summarizer asks Codex to use, or `undefined` to leave the
 * choice to Codex.
 *
 * This is a fork-local addition: it is deliberately absent from
 * `computerHistorySettingsSchema`, which mirrors the recovered settings
 * surface. Blank, non-string, and absent values all mean "unset". Codex accepts
 * unknown model names without an error and falls back to guessed metadata, so
 * a typo here degrades quietly rather than failing.
 */
export async function getSummaryModel(): Promise<string | undefined> {
  const configured = (await readComputerHistoryConfig())["summaryModel"];
  if (typeof configured !== "string") {
    return undefined;
  }
  const trimmed = configured.trim();
  return trimmed === "" ? undefined : trimmed;
}

export async function getComputerHistorySettings(): Promise<ComputerHistorySettings> {
  const parsed = computerHistorySettingsSchema.safeParse(
    await readComputerHistoryConfig(),
  );
  return parsed.success ? parsed.data : structuredClone(defaultSettings);
}

export async function updateComputerHistorySettings(
  settings: ComputerHistorySettings,
): Promise<ComputerHistorySettings> {
  validateRules(settings);
  const parsed = computerHistorySettingsSchema.parse(settings);
  // Replace only the recovered keys. Writing `parsed` alone would drop every
  // entry the schema does not model, silently reverting `captureText` to the
  // recorder's default and deleting a configured `summaryModel`.
  const merged = { ...(await readComputerHistoryConfig()), ...parsed };
  const path = configPath();
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return parsed;
}

function validateRules(settings: ComputerHistorySettings): void {
  for (const rule of [
    ...settings.observation.allowlist,
    ...settings.observation.blocklist,
  ]) {
    if (rule.scope === "application" && !rule.bundleID) {
      throw new Error("Application observation rules require bundleID.");
    }
    if (rule.scope === "url" && !rule.urlDomain) {
      throw new Error("URL observation rules require urlDomain.");
    }
    if (rule.scope === "application" && rule.urlDomain) {
      throw new Error("Application observation rules cannot include urlDomain.");
    }
    if (rule.scope === "url" && rule.bundleID) {
      throw new Error("URL observation rules cannot include bundleID.");
    }
  }
}
