import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getComputerHistorySettings,
  getSummaryModel,
  updateComputerHistorySettings,
} from "../src/settings.ts";

async function configHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "open-history-settings-test-"));
  process.env.OPEN_COMPUTER_HISTORY_HOME = home;
  return home;
}

async function writeConfig(home: string, value: unknown): Promise<void> {
  await writeFile(join(home, "config.json"), `${JSON.stringify(value)}\n`);
}

test("settings update preserves entries outside the recovered schema", async () => {
  const home = await configHome();
  await writeConfig(home, {
    captureText: false,
    summaryModel: "gpt-5.6-luna",
  });

  await updateComputerHistorySettings({
    observation: {
      defaultApplicationBehavior: "observe",
      defaultURLBehavior: "observe",
      allowlist: [],
      blocklist: [
        { scope: "application", bundleID: "com.apple.keychainaccess" },
      ],
    },
    showMenuBarIcon: true,
  });

  const written = JSON.parse(
    await readFile(join(home, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(written["captureText"], false);
  assert.equal(written["summaryModel"], "gpt-5.6-luna");
  assert.equal(written["showMenuBarIcon"], true);
  assert.deepEqual(written["observation"], {
    defaultApplicationBehavior: "observe",
    defaultURLBehavior: "observe",
    allowlist: [],
    blocklist: [{ scope: "application", bundleID: "com.apple.keychainaccess" }],
  });
});

test("recovered settings response omits fork-local keys", async () => {
  const home = await configHome();
  await writeConfig(home, {
    summaryModel: "gpt-5.6-luna",
    captureText: false,
    showMenuBarIcon: false,
    observation: {
      defaultApplicationBehavior: "do_not_observe",
      defaultURLBehavior: "observe",
      allowlist: [],
      blocklist: [],
    },
  });

  const settings = await getComputerHistorySettings();
  assert.equal(settings.showMenuBarIcon, false);
  assert.equal(
    settings.observation.defaultApplicationBehavior,
    "do_not_observe",
  );
  assert.deepEqual(Object.keys(settings).sort(), [
    "observation",
    "showMenuBarIcon",
  ]);
});

test("summary model reads trimmed values and treats blanks as unset", async () => {
  const home = await configHome();
  assert.equal(await getSummaryModel(), undefined);

  await writeConfig(home, { summaryModel: "  gpt-5.6-luna  " });
  assert.equal(await getSummaryModel(), "gpt-5.6-luna");

  await writeConfig(home, { summaryModel: "   " });
  assert.equal(await getSummaryModel(), undefined);

  await writeConfig(home, { summaryModel: 7 });
  assert.equal(await getSummaryModel(), undefined);
});
