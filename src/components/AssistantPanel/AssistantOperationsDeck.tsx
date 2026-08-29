import { cn } from "@/lib/utils";
import { AssistantTimersSection } from "./AssistantTimersSection";
import type { AssistantOperations, AssistantTimers } from "@/store/assistantStore";

/**
 * The operations deck, ported from the cockpit's own (internal/ui/render_operations.go).
 *
 * Same seven sections in the same order — NOW, NEEDS ATTENTION, WORKFLOWS, AGENTS,
 * ASYNC, SCHEDULED, RECENT — because they answer different questions and the order is
 * the priority: what is wrong, then what is planned, then what is running, then what
 * already happened.
 *
 * This is the surface the panel's own copy promises. It says the assistant "keeps watch
 * on the runs", and without a deck that claim had nothing behind it: the watchers,
 * timers, async work and audit trail all existed and none of them were visible.
 *
 * Empty sections are OMITTED rather than shown empty. A deck of seven "nothing here"
 * headings buries the one section that has something in it, and the cockpit dropped
 * them for the same reason.
 */

export interface AssistantOperationsDeckProps {
  operations: AssistantOperations | null;
  /**
   * The timer manager's own reading, when it has one.
   *
   * Preferred over `operations.timers` because it is the list a cancel updates: the
   * two are the same rows from the same engine builder, but only this one is refreshed
   * when a timer is retired, so reading the deck snapshot would leave a cancelled timer
   * counting down until the next full deck pull.
   */
  timers: AssistantTimers | null;
  /** A timer has fired since this reading, so the list is known to be behind. */
  timersStale: boolean;
  timerCancelPending: Record<string, true>;
  timerCancelErrors: Record<string, string>;
  onCancelTimer: (timerId: string) => void;
  /** Ask the engine for a fresh reading. Refreshes the deck AND the timer list. */
  onRefresh: () => void;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="mb-1 assistant-text-sm font-medium tracking-wide text-[var(--assistant-fg-secondary)]">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ children, tone }: { children: React.ReactNode; tone?: "warning" | "danger" }) {
  return (
    <div
      className={cn(
        "rounded-sm px-1.5 py-1 assistant-text-base",
        tone === "danger"
          ? "text-[var(--assistant-danger)]"
          : tone === "warning"
            ? "text-[var(--assistant-warning)]"
            : undefined
      )}
    >
      {children}
    </div>
  );
}

/** Relative time, since every row on this deck is "how long ago" or "how long until". */
function ago(at: number, now: number): string {
  const ms = Math.abs(now - at);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function AssistantOperationsDeck({
  operations,
  timers,
  timersStale,
  timerCancelPending,
  timerCancelErrors,
  onCancelTimer,
  onRefresh,
  onClose,
}: AssistantOperationsDeckProps) {
  const now = Date.now();
  const ops = operations;
  const timerRows = timers?.rows ?? ops?.timers ?? [];
  const outcomes = timers?.outcomes ?? [];

  const running = ops ? ops.agents.length + ops.async.length : 0;
  const attention = ops ? ops.inbox.length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--assistant-border)] px-3 py-1.5">
        <span className="assistant-text-base font-medium">Operations</span>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-sm px-1.5 py-0.5 assistant-text-sm text-[var(--assistant-fg-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-sm px-1.5 py-0.5 assistant-text-sm text-[var(--assistant-fg-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!ops ? (
          <p className="assistant-text-base text-[var(--assistant-fg-secondary)]">Reading…</p>
        ) : (
          <>
            {/* NOW: the one-line rollup the cockpit led with, so the deck answers
                "is anything happening" before it answers "what". */}
            <Section title="NOW">
              <Row tone={attention > 0 ? "warning" : undefined}>
                {running === 0 && attention === 0
                  ? "Nothing running, nothing waiting on you."
                  : [
                      running > 0 ? `${running} running` : null,
                      attention > 0 ? `${attention} needing you` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                  read {ago(ops.at, now)} ago
                </span>
                {/* A timer fired since this reading was taken. Said out loud rather
                    than silently refreshed, because the deck is a snapshot and a list
                    that changes under a reader who did not ask is worse than one that
                    admits it is behind. */}
                {timersStale ? (
                  <span className="ml-2 text-[var(--assistant-warning)]">
                    a timer has fired since — refresh
                  </span>
                ) : null}
              </Row>
            </Section>

            {ops.inbox.length > 0 && (
              <Section title="NEEDS ATTENTION">
                {ops.inbox.map((row) => (
                  <Row key={row.id} tone={row.severity === "urgent" ? "danger" : "warning"}>
                    <span className="text-[var(--assistant-fg-secondary)]">{row.source} · </span>
                    {row.summary}
                    <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                      {ago(row.at, now)} ago
                    </span>
                  </Row>
                ))}
              </Section>
            )}

            {ops.workflows.length > 0 && (
              <Section title="WORKFLOWS">
                {ops.workflows.map((row) => (
                  <Row key={row.id} tone={row.blocked ? "warning" : undefined}>
                    <div className="truncate">{row.goal}</div>
                    <div className="text-[var(--assistant-fg-secondary)]">
                      {row.progress}
                      {row.next ? ` · next: ${row.next}` : ""}
                    </div>
                  </Row>
                ))}
              </Section>
            )}

            {ops.agents.length > 0 && (
              <Section title="AGENTS">
                {ops.agents.map((row) => (
                  <Row key={row.id} tone={row.needsAttention ? "warning" : undefined}>
                    <div className="truncate">
                      {row.title || row.id}
                      {row.agentState ? (
                        <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                          {row.agentState}
                        </span>
                      ) : null}
                      <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                        {ago(row.startedAt, now)}
                      </span>
                    </div>
                    {row.goal ? (
                      <div className="truncate text-[var(--assistant-fg-secondary)]">
                        {row.goal}
                      </div>
                    ) : null}
                    {/* The terminal tail, so a supervisor can see it working rather than
                        take the state label's word for it. */}
                    {row.preview ? (
                      <div className="mt-0.5 truncate assistant-text-sm text-[var(--assistant-fg-secondary)]">
                        {row.preview}
                      </div>
                    ) : null}
                  </Row>
                ))}
              </Section>
            )}

            {ops.async.length > 0 && (
              <Section title="ASYNC">
                {ops.async.map((row) => (
                  <Row key={row.id}>
                    <span className="truncate">{row.title || row.tool}</span>
                    <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                      {ago(row.startedAt, now)}
                    </span>
                  </Row>
                ))}
              </Section>
            )}

            {/* Unlike every other section here, SCHEDULED draws even when it is
                empty IF the read failed. An omitted section reads as "nothing
                scheduled", and that is a claim a user acts on by walking away from
                work that is still queued. */}
            {(timerRows.length > 0 || timers?.readFailed) && (
              <Section title="SCHEDULED">
                {timers?.readFailed ? (
                  <Row tone="warning">
                    Couldn&apos;t read the scheduled timers, so this list may be incomplete. Refresh
                    to try again.
                  </Row>
                ) : null}
                <AssistantTimersSection
                  timers={timerRows}
                  pending={timerCancelPending}
                  errors={timerCancelErrors}
                  onCancel={onCancelTimer}
                  now={now}
                />
              </Section>
            )}

            {/* FIRED sits after SCHEDULED because it answers the second question, and
                because a fired timer has LEFT the list above — without this section the
                deck can only ever show what has not happened yet, which is how a timer
                could fire, fail, and leave the panel showing nothing at all. */}
            {outcomes.length > 0 && (
              <Section title="FIRED">
                {outcomes.map((row) => (
                  <Row key={row.eventId} tone={row.severity === "error" ? "danger" : undefined}>
                    <div className="truncate">
                      {row.title}
                      {/* A repeating timer publishes under one dedupe key, so this row
                          stands for every firing since it was first raised. Without the
                          count a reader would take twelve failures for one. */}
                      {row.count > 1 ? (
                        <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                          ×{row.count}
                        </span>
                      ) : null}
                      <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                        {ago(row.updatedAt || row.createdAt, now)} ago
                      </span>
                    </div>
                    <div className="truncate text-[var(--assistant-fg-secondary)]">
                      {row.summary}
                    </div>
                  </Row>
                ))}
              </Section>
            )}

            {ops.audit.length > 0 && (
              <Section title="RECENT">
                {ops.audit.map((row, i) => (
                  <Row
                    key={`${row.tool}-${row.at}-${i}`}
                    tone={row.outcome !== "ok" && row.outcome !== "grant_ok" ? "danger" : undefined}
                  >
                    <span className="text-[var(--assistant-fg)]">{row.tool}</span>
                    <span className="ml-2 text-[var(--assistant-fg-secondary)]">{row.outcome}</span>
                    <span className="ml-2 text-[var(--assistant-fg-secondary)]">
                      {row.durationMs}ms · {ago(row.at, now)} ago
                    </span>
                  </Row>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
