import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTriageStore } from "@/store/triageStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { isMac } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useOverlayClaim } from "@/hooks/useOverlayState";
import { AppPaletteDialog, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { buildPilotGroups, type PilotWorkspaceMeta } from "@/components/Pilot/pilotRows";
import { TRIAGE_ATTENTION_CATEGORIES } from "@shared/types/ipc/triage";
import { buildTriageSections, type TriageItem, type TriageSectionId } from "./triageModel";
import {
  TriageCard,
  canReplyTo,
  canTrashItem,
  triageCardDomId,
  type TriageCardHandlers,
} from "./TriageCard";

/** Ages are minute-grained, as in Pilot. */
const AGE_TICK_MS = 30_000;

const SECTION_LABEL: Record<TriageSectionId, string> = {
  "needs-you": "Needs you",
  working: "Working",
  quiet: "Quiet",
};

/** An error toast whose one recovery is the place the action can be done by hand. */
function failToast(
  title: string,
  error: unknown,
  recovery: { label: string; onClick: () => void }
) {
  notify({
    type: "error",
    title,
    message: formatErrorMessage(error, "Something went wrong."),
    context: { eventKind: "agent" },
    duration: 6000,
    actions: [recovery],
  });
}

/**
 * Every agent across every project, read off its screen and laid out by what
 * it needs from you: menus to answer, questions to reply to, finished work to
 * look at or clear away. Pilot's population and ordering, with the words and
 * the controls to act without leaving the panel.
 */
export function TriageView() {
  const isOpen = useTriageStore((s) => s.isOpen);
  const close = useTriageStore((s) => s.close);
  const triage = useTriageStore((s) => s.snapshot);
  const applySnapshot = useTriageStore((s) => s.applySnapshot);
  const fleet = useFleetSnapshotStore((s) => s.snapshot);
  const projects = useProjectStore((s) => s.projects);
  const scratches = useScratchStore((s) => s.scratches);
  const shortcut = useEffectiveCombo("triage.toggle");
  useOverlayClaim("triage", isOpen);

  // Main watches screens only while some view says a panel is open.
  useEffect(() => {
    if (!isOpen) return;
    const unsubscribe = window.electron.triage.onSnapshotUpdated(applySnapshot);
    safeFireAndForget(window.electron.triage.setActive(true).then(applySnapshot));
    return () => {
      unsubscribe();
      safeFireAndForget(window.electron.triage.setActive(false));
    };
  }, [isOpen, applySnapshot]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isOpen) return;
    const handle = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(handle);
  }, [isOpen]);

  const workspaces = useMemo(() => {
    const map = new Map<string, PilotWorkspaceMeta>();
    for (const project of projects) {
      map.set(project.id, {
        kind: "project",
        name: project.name,
        lastOpened: project.lastOpened,
        ...(project.emoji ? { emoji: project.emoji } : {}),
        ...(project.color ? { color: project.color } : {}),
        ...(project.lastCompletionSeenAt !== undefined
          ? { lastCompletionSeenAt: project.lastCompletionSeenAt }
          : {}),
      });
    }
    for (const scratch of scratches) {
      map.set(scratch.id, {
        kind: "scratch",
        name: scratch.name,
        lastOpened: scratch.lastOpened,
        ...(scratch.lastCompletionSeenAt !== undefined
          ? { lastCompletionSeenAt: scratch.lastCompletionSeenAt }
          : {}),
      });
    }
    return map;
  }, [projects, scratches]);

  const sections = useMemo(() => {
    if (!fleet) return [];
    const groups = buildPilotGroups(fleet.runs, {
      workspaces,
      currentWorkspaceId: getViewWorkspaceId(),
      nowMs,
    });
    const cards = new Map((triage?.cards ?? []).map((card) => [card.runId, card]));
    return buildTriageSections(groups, cards, {
      // Unknown until main answers, which is still a read on its way.
      configured: triage?.configured ?? true,
      failed: (triage?.lastError ?? null) !== null,
    });
  }, [fleet, workspaces, nowMs, triage]);

  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = items.findIndex((item) => item.runId === focusedId);
  const activeIndex = focusedIndex === -1 ? 0 : focusedIndex;
  const bodyRef = useRef<HTMLDivElement>(null);

  const focusCardNow = useCallback((runId: string) => {
    setFocusedId(runId);
    const element = document.getElementById(triageCardDomId(runId));
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  }, []);

  // Land the keyboard on the most urgent card on open. Two frames, so it lands
  // after the palette's own first-tabbable focus rather than racing it, and
  // cancelled on cleanup so a StrictMode replay schedules it afresh.
  const landedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      landedRef.current = false;
      setFocusedId(null);
      return;
    }
    if (landedRef.current || items.length === 0) return;
    const target = items[0]!.runId;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        landedRef.current = true;
        focusCardNow(target);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [isOpen, items, focusCardNow]);

  // The focused card left (trashed, answered into another section, exited):
  // put the keyboard on the card that took its place instead of dropping it on
  // the page. Only when focus really was lost — a composer the user is typing
  // in elsewhere keeps it.
  const lastIndexRef = useRef(0);
  useEffect(() => {
    if (focusedIndex !== -1) lastIndexRef.current = focusedIndex;
    if (!landedRef.current || focusedId === null || items.length === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    // Either the card left, or it moved section and its node was replaced.
    const target =
      focusedIndex !== -1
        ? items[focusedIndex]!
        : items[Math.min(lastIndexRef.current, items.length - 1)]!;
    focusCardNow(target.runId);
  }, [focusedIndex, focusedId, items, focusCardNow]);

  // On the list's own wrapper rather than the palette body: the body only acts
  // on keys aimed at itself, and here focus is always on a card or its controls.
  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (items.length === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("textarea, input")) return;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") {
      next = Math.min(items.length - 1, activeIndex + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      next = Math.max(0, activeIndex - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      focusCardNow(items[next]!.runId);
    }
  };

  // The pointer moves the same cursor the arrows do — but never out of a reply
  // being typed, and without a ring, which belongs to the keyboard.
  const onPointerCursor = useCallback((element: HTMLElement) => {
    const active = document.activeElement;
    if (active instanceof Element && active.closest("textarea, input")) return;
    element.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  }, []);

  // Answered: the agent goes back to work, so the cursor goes on to whatever
  // is still waiting rather than following it out of the queue.
  const advancePast = useCallback(
    (runId: string) => {
      const card = document.getElementById(triageCardDomId(runId));
      const active = document.activeElement;
      if (active !== null && active !== document.body && !card?.contains(active)) return;
      const index = items.findIndex((item) => item.runId === runId);
      const next = items
        .slice(index + 1)
        .find((item) => TRIAGE_ATTENTION_CATEGORIES.has(item.kind) && item.kind !== "finished");
      if (next) focusCardNow(next.runId);
    },
    [items, focusCardNow]
  );

  const handlers = useMemo<TriageCardHandlers>(() => {
    const openRun = (item: TriageItem) => {
      const args = { runId: item.runId, workspaceId: item.workspaceId };
      if (item.workspaceId !== getViewWorkspaceId()) {
        // The switch replaces this view, so the panel closes first.
        close();
        void actionService.dispatch("pilot.openRun", args, { source: "user" });
        return;
      }
      // Here already: focus the terminal while the panel is still open, and
      // close only once that worked. `pilot.openRun` arms the palette's
      // focus-restore suppression on success, so the close can't hand focus
      // back to whatever opened the panel.
      void actionService.dispatch("pilot.openRun", args, { source: "user" }).then((result) => {
        if (result.ok) close();
      });
    };
    // From the card the user acted on, so main refuses it once that card is stale.
    const target = (item: TriageItem) => ({
      spawnedAt: item.card?.spawnedAt ?? item.row.run.spawnedAt,
      question: item.card?.question ?? null,
    });
    const goTo = (item: TriageItem) => ({ label: "Go to terminal", onClick: () => openRun(item) });
    return {
      onOpen: openRun,
      onChoose: async (item, label) => {
        try {
          await window.electron.triage.choose(item.runId, label, target(item));
          advancePast(item.runId);
        } catch (error) {
          failToast("Couldn't answer agent", error, goTo(item));
          throw error;
        }
      },
      onReply: async (item, text) => {
        try {
          await window.electron.triage.reply(item.runId, text, target(item));
          if (item.kind === "question") advancePast(item.runId);
        } catch (error) {
          failToast("Couldn't send message", error, goTo(item));
          throw error;
        }
      },
      onTrash: (item) => {
        const runId = item.runId;
        safeFireAndForget(
          window.electron.triage.trash(runId, target(item)).then(
            () => {
              notify({
                type: "success",
                // One-shot: its only job is the Undo, which means nothing once it has gone.
                transient: true,
                title: "Terminal trashed",
                message: item.row.title,
                context: { eventKind: "agent" },
                duration: 5000,
                actions: [
                  {
                    label: "Undo",
                    onClick: () => safeFireAndForget(window.electron.terminal.restore(runId)),
                  },
                ],
              });
            },
            (error: unknown) => failToast("Couldn't trash terminal", error, goTo(item))
          )
        );
      },
    };
  }, [close, advancePast]);

  const counts = useMemo(() => {
    const byId = new Map(sections.map((section) => [section.id, section.items.length]));
    return {
      needsYou: byId.get("needs-you") ?? 0,
      working: byId.get("working") ?? 0,
      quiet: byId.get("quiet") ?? 0,
    };
  }, [sections]);

  const busy = triage?.busy === true;
  const focusedItem = items[activeIndex] ?? null;
  // The footer speaks for whatever holds focus: inside a reply, Enter sends.
  const [typing, setTyping] = useState(false);
  const footerHints = useMemo(() => {
    if (!focusedItem) return [];
    if (typing) return [{ keys: ["⇧", "↵"], label: "New line" }];
    const hints = [{ keys: ["↑", "↓"], label: "Move" }];
    if (focusedItem.kind === "approval" && (focusedItem.card?.options.length ?? 0) > 0) {
      hints.push({ keys: ["1–9"], label: "Answer" });
    }
    if (canReplyTo(focusedItem)) {
      hints.push({ keys: ["R"], label: "Reply" });
    }
    if (canTrashItem(focusedItem)) {
      hints.push({ keys: [isMac() ? "⌘" : "Ctrl", "⌫"], label: "Trash" });
    }
    return hints;
  }, [focusedItem, typing]);

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={close} ariaLabel="Triage" tier="workspace">
      <AppPaletteDialog.Header
        label="Triage"
        shortcut={shortcut}
        isLoading={busy}
        trailing={
          triage?.refreshedAt ? (
            <span className="text-xs text-text-secondary">
              <TimeAgo timestamp={triage.refreshedAt} now={nowMs} prefix="Scanned " />
            </span>
          ) : null
        }
      >
        <div className="flex items-center gap-3 px-1 pb-1">
          <p className="min-w-0 flex-1 truncate text-sm text-text-secondary">
            {fleet === null
              ? "Reading agents…"
              : items.length === 0
                ? "No agents are running"
                : [
                    counts.needsYou > 0
                      ? `${pluralize(counts.needsYou, "needs", "need")} you`
                      : null,
                    counts.working > 0 ? `${counts.working.toLocaleString()} working` : null,
                    counts.quiet > 0 ? `${counts.quiet.toLocaleString()} quiet` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
          </p>
          <Button
            variant="ghost"
            size="xs"
            disabled={triage?.configured !== true}
            onClick={() =>
              safeFireAndForget(
                window.electron.triage.refresh().catch((error: unknown) =>
                  failToast("Couldn't refresh triage", error, {
                    label: "Retry",
                    onClick: () => safeFireAndForget(window.electron.triage.refresh()),
                  })
                )
              )
            }
          >
            <RefreshCw className={cn(busy && "animate-spin motion-reduce:animate-none")} />
            Refresh
          </Button>
        </div>
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body
        ariaLabel="Agents"
        maxHeight="max-h-[70vh]"
        scrollClassName="flex flex-col gap-4 p-2"
        onNavigationKeyDown={onNavigationKeyDown}
      >
        <div
          ref={bodyRef}
          className="contents"
          onKeyDown={onNavigationKeyDown}
          onFocusCapture={(event) =>
            setTyping(
              event.target instanceof Element &&
                event.target.closest("[data-triage-composer]") !== null
            )
          }
          onBlurCapture={() => setTyping(false)}
        >
          {triage !== null && !triage.configured && (
            <Callout
              severity="neutral"
              size="compact"
              title="Screen reading is off"
              action={
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    close();
                    window.dispatchEvent(
                      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "triage" } })
                    );
                  }}
                >
                  Add keys
                </Button>
              }
            >
              Add your TypeSafe and Cerebras keys in Settings to read each agent's screen. Until
              then the cards show only what Daintree's own state tracking saw.
            </Callout>
          )}
          {triage?.lastError && (
            <Callout severity="warning" size="compact" title="Some cards couldn't be read">
              {triage.lastError}. They'll be retried on the next scan.
            </Callout>
          )}
          {sections.map((section) => (
            <section key={section.id} className="flex flex-col gap-1">
              <h3
                id={`triage-section-${section.id}`}
                className={cn(PALETTE_SECTION_LABEL_CLASS, "px-2.5")}
              >
                {SECTION_LABEL[section.id]}
                <span className="ml-1.5 tabular-nums">{section.items.length}</span>
              </h3>
              <div
                role="feed"
                aria-labelledby={`triage-section-${section.id}`}
                aria-busy={busy}
                className="flex flex-col gap-0.5"
              >
                {section.items.map((item, index) => (
                  <TriageCard
                    key={item.runId}
                    item={item}
                    domId={triageCardDomId(item.runId)}
                    isFocused={focusedItem?.runId === item.runId}
                    position={index + 1}
                    setSize={section.items.length}
                    onFocusCard={() => setFocusedId(item.runId)}
                    onPointerCursor={onPointerCursor}
                    {...handlers}
                  />
                ))}
              </div>
            </section>
          ))}
          {fleet !== null && items.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-text-secondary">
              Launch an agent and it shows up here.
            </p>
          )}
        </div>
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        {focusedItem && (
          <PaletteFooterHints
            primaryHint={
              typing ? { keys: ["↵"], label: "Send" } : { keys: ["↵"], label: "Go to terminal" }
            }
            hints={footerHints}
          />
        )}
        {triage?.configured && (
          <span className="ml-auto shrink-0 whitespace-nowrap text-2xs text-text-secondary">
            AI summaries · {triage.describerModel}
          </span>
        )}
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
