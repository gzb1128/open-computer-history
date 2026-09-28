import { useEffect, useMemo, useState } from "react";
import {
  ThemeProvider,
  useCallTool,
  useSendFollowUp,
  useToolContext,
  type ViewConfig,
} from "mcp-use/react";
import styles from "./view.module.css";
import { formatTime, groupEntries } from "./time.js";

export const viewConfig = {
  autoResize: true,
  displayModes: ["inline", "fullscreen"],
} satisfies ViewConfig;

export default function ComputerHistoryView() {
  const context = useToolContext<"show-computer-history">();
  if (context.status === "pending") return <TimelineSkeleton />;
  if (context.status === "error") {
    return <div className={styles.error}>{context.error.message}</div>;
  }
  return <Timeline data={context.toolOutput} />;
}

function Timeline({
  data,
}: {
  data: {
    status: {
      state: "stopped" | "running" | "paused";
    };
    entryCount: number;
    entries: TimelineEntry[];
    timeZone?: string;
  };
}) {
  const [entries, setEntries] = useState(data.entries);
  const [confirmID, setConfirmID] = useState<string | null>(null);
  const deleteTool = useCallTool("delete-computer-history-item");
  const sendFollowUp = useSendFollowUp();
  const timeZone = data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => setEntries(data.entries), [data.entries]);
  const groups = useMemo(() => groupEntries(entries, timeZone), [entries, timeZone]);

  async function remove(id: string) {
    if (confirmID !== id) {
      setConfirmID(id);
      return;
    }
    await deleteTool.callTool({ id });
    setEntries((current) => current.filter((entry) => entry.id !== id));
    setConfirmID(null);
  }

  return (
    <ThemeProvider>
      <main className={styles.canvas}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>
              <span
                className={`${styles.statusDot} ${styles[data.status.state]}`}
                aria-hidden="true"
              />
              Computer History
            </div>
            <h1>History</h1>
            <p className={styles.subtitle}>
              Text summaries of recent work across allowed apps and websites.
            </p>
          </div>
          <button
            className={styles.primaryAction}
            type="button"
            onClick={() =>
              sendFollowUp({
                prompt:
                  "Use my Computer History to tell me what I was working on most recently and what remains unfinished.",
              })
            }
          >
            Ask about history
          </button>
        </header>

        <div className={styles.summaryStrip}>
          <span>{statusLabel(data.status.state)}</span>
          <span className={styles.count}>{entries.length} summaries</span>
          <span className={styles.count}>Times: {timeZone}</span>
        </div>

        {entries.length === 0 ? (
          <EmptyState onAsk={sendFollowUp} />
        ) : (
          <div className={styles.groups}>
            {groups.map(([label, items]) => (
              <section className={styles.group} key={label}>
                <h2>{label}</h2>
                <div className={styles.timeline}>
                  {items.map((entry) => (
                    <article className={styles.entry} key={entry.id}>
                      <time dateTime={entry.start}>
                        {formatTime(entry.start, timeZone)}
                      </time>
                      <div className={styles.rail} aria-hidden="true">
                        <span />
                      </div>
                      <div className={styles.entryBody}>
                        <div className={styles.entryHeading}>
                          <div>
                            <h3>{entry.title}</h3>
                            <p>{entry.description}</p>
                            {entry.summaryTimeZone == null && (
                              <p className={styles.timeNote}>Older summary: times in its text may use an unknown time zone.</p>
                            )}
                            {entry.summaryTimeZone != null && entry.summaryTimeZone !== timeZone && (
                              <p className={styles.timeNote}>Summary text: {entry.summaryTimeZone}</p>
                            )}
                          </div>
                          <button
                            type="button"
                            className={`${styles.deleteAction} ${
                              confirmID === entry.id ? styles.confirming : ""
                            }`}
                            aria-label={`Delete ${entry.title}`}
                            onBlur={() => setConfirmID(null)}
                            onClick={() => remove(entry.id)}
                          >
                            {confirmID === entry.id ? "Confirm" : "Delete"}
                          </button>
                        </div>
                        <ApplicationList applications={entry.applications} />
                        {entry.suggestion && (
                          <button
                            type="button"
                            className={styles.suggestion}
                            onClick={() =>
                              sendFollowUp({
                                prompt: entry.suggestion!.description,
                              })
                            }
                          >
                            <span className={styles.suggestionType}>
                              Suggested {entry.suggestion.type}
                            </span>
                            <span>{entry.suggestion.name}</span>
                            <span className={styles.arrow} aria-hidden="true">
                              ↗
                            </span>
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </ThemeProvider>
  );
}

interface TimelineEntry {
  id: string;
  title: string;
  description: string;
  applications: string[];
  start: string;
  end: string;
  localStart?: string;
  localEnd?: string;
  summaryTimeZone?: string | null;
  level: "10min" | "6h";
  suggestion?: {
    type: "skill" | "automation";
    name: string;
    description: string;
  };
}

function ApplicationList({ applications }: { applications: string[] }) {
  if (!applications.length) return null;
  return (
    <ul className={styles.applications} aria-label="Contributing applications">
      {applications.map((application, index) => (
        <li key={application}>
          <span
            className={`${styles.appIcon} ${styles[`appTone${index % 5}`]}`}
            aria-hidden="true"
          >
            {applicationInitial(application)}
          </span>
          {displayApplication(application)}
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  onAsk,
}: {
  onAsk: (args: { prompt: string }) => Promise<void>;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyMark} aria-hidden="true">
        ◷
      </span>
      <h2>No history yet</h2>
      <p>
        Start the recorder and Computer History will place concise activity
        summaries here.
      </p>
      <button
        type="button"
        onClick={() =>
          onAsk({
            prompt:
              "Check whether my local Computer History recorder is running and help me finish setup if needed.",
          })
        }
      >
        Check setup
      </button>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className={styles.skeleton} aria-label="Loading Computer History">
      <span />
      <span />
      <span />
    </div>
  );
}

function statusLabel(state: "stopped" | "running" | "paused") {
  if (state === "running") return "Recording activity";
  if (state === "paused") return "Recording paused";
  return "Recorder stopped";
}

function displayApplication(bundleIdentifier: string) {
  const known: Record<string, string> = {
    "com.google.Chrome": "Chrome",
    "com.apple.Safari": "Safari",
    "com.apple.finder": "Finder",
    "com.tinyspeck.slackmacgap": "Slack",
    "notion.id": "Notion",
  };
  return known[bundleIdentifier] ?? bundleIdentifier.split(".").at(-1) ?? bundleIdentifier;
}

function applicationInitial(bundleIdentifier: string) {
  return displayApplication(bundleIdentifier).slice(0, 1).toUpperCase();
}
