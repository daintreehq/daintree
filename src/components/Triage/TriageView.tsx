import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";
import { ScanEye } from "@/components/icons";
import { cn } from "@/lib/utils";
import { isTriageRead, triagePromptKey, useTriageStore } from "@/store/triageStore";
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
import { AppDialog } from "@/components/ui/AppDialog";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { Callout } from "@/components/ui/Callout";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { buildPilotGroups, type PilotWorkspaceMeta } from "@/components/Pilot/pilotRows";
import { buildTriageInbox, itemNeedsAttention, type TriageItem } from "./triageModel";
import {
  TriageCard,
  canReplyTo,
  canTrashItem,
  triageCardDomId,
  type TriageCardHandle,
  type TriageCardHandlers,
} from "./TriageCard";
import { TriageRow } from "./TriageRow";

/** Ages are minute-grained, as in Pilot. */
const AGE_TICK_MS = 30_000;

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

  const items = useMemo(() => {
    if (!fleet) return [];
    const groups = buildPilotGroups(fleet.runs, {
      workspaces,
      currentWorkspaceId: getViewWorkspaceId(),
      nowMs,
    });
    const cards = new Map((triage?.cards ?? []).map((card) => [card.runId, card]));
    return buildTriageInbox(groups, cards, {
      // Unknown until main answers, which is still a read on its way.
      configured: triage?.configured ?? true,
      failed: (triage?.lastError ?? null) !== null,
    });
  }, [fleet, workspaces, nowMs, triage]);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = items.findIndex((item) => item.runId === focusedId);
  const activeIndex = focusedIndex === -1 ? 0 : focusedIndex;
  const bodyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<TriageCardHandle>(null);

  // Where the keyboard goes when the panel closes: the terminal "Go to
  // terminal" just focused, rather than whatever opened the panel.
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  const reads = useTriageStore((s) => s.reads);
  const markRead = useTriageStore((s) => s.markRead);
  const pruneReads = useTriageStore((s) => s.pruneReads);
  useEffect(() => {
    // Only against a whole, current population: a degraded snapshot can leave
    // runs out that are still running.
    if (fleet && !fleet.degraded) pruneReads(new Set(fleet.runs.map((run) => run.runId)));
  }, [fleet, pruneReads]);
  const isUnread = useCallback(
    (item: TriageItem) =>
      itemNeedsAttention(item) &&
      !isTriageRead(reads[item.runId], item.row.run.spawnedAt, item.card),
    [reads]
  );
  // Opening a run — a click or the arrows onto it — reads it, as in a mail
  // inbox. Landing on the first run when the panel opens does not.
  const openedByUser = useCallback(
    (item: TriageItem) => markRead(item.runId, item.row.run.spawnedAt),
    [markRead]
  );

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
    focusAfterCloseRef.current = null;
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
  const refreshRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusedIndex !== -1) lastIndexRef.current = focusedIndex;
    if (!landedRef.current || focusedId === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    if (items.length === 0) {
      // The last run left: the one control still in reach is Refresh.
      refreshRef.current?.focus();
      return;
    }
    // Either the card left, or it moved section and its node was replaced.
    const target =
      focusedIndex !== -1
        ? items[focusedIndex]!
        : items[Math.min(lastIndexRef.current, items.length - 1)]!;
    focusCardNow(target.runId);
  }, [focusedIndex, focusedId, items, focusCardNow]);

  // Answered: the agent goes back to work, so the cursor goes on to whatever
  // is still waiting rather than following it out of the queue.
  const advancePast = useCallback(
    (runId: string) => {
      const card = document.getElementById(triageCardDomId(runId));
      const pane = document.getElementById(`triage-detail-${runId}`);
      const active = document.activeElement;
      if (
        active !== null &&
        active !== document.body &&
        !card?.contains(active) &&
        !pane?.contains(active)
      )
        return;
      // Onward first, then back round to anything left above; never to a prompt
      // this panel has already answered while main catches up.
      const acks = useTriageStore.getState().acks;
      const index = items.findIndex((item) => item.runId === runId);
      const waiting = (item: TriageItem) =>
        item.runId !== runId &&
        itemNeedsAttention(item) &&
        item.kind !== "finished" &&
        !(item.card !== null && acks[item.runId]?.promptKey === triagePromptKey(item.card));
      const next =
        items.slice(index + 1).find(waiting) ?? items.slice(0, Math.max(index, 0)).find(waiting);
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
        if (!result.ok) return;
        // `pilot.openRun` arms the palettes' one-shot restore suppression; this
        // is a dialog, which hands focus on by its own target instead, so the
        // flag is taken here rather than left for the next palette to close.
        consumePaletteFocusRestoreSuppression();
        focusAfterCloseRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        close();
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
      onSent: (item) => openedByUser(item),
      onSendFailed: (item, error) => failToast("Couldn't send to agent", error, goTo(item)),
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
  }, [close, advancePast, openedByUser]);

  // On the list's own wrapper rather than the palette body: the body only acts
  // on keys aimed at itself, and here focus is always on a card or its controls.
  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (items.length === 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    // Only from the list: the pane holds a live terminal and a composer, and
    // every key there belongs to the agent.
    if (!(event.target instanceof Element) || !event.target.closest("[data-triage-list]")) return;
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
      openedByUser(items[next]!);
      return;
    }
    // Keys aimed at the list's selected row act on the selected agent.
    const selected = items[activeIndex];
    if (!selected) return;
    if (event.key === "Enter") {
      event.preventDefault();
      handlers.onOpen(selected);
      return;
    }
    detailRef.current?.handleKey(event);
  };

  const needsYou = items.filter(itemNeedsAttention).length;

  const busy = triage?.busy === true;
  const focusedItem = items[activeIndex] ?? null;
  // The footer speaks for whatever holds focus: inside a reply, Enter sends.
  const [typing, setTyping] = useState(false);
  const unreadCount = items.filter(isUnread).length;
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

  const summaryLine =
    fleet === null
      ? "Reading agents…"
      : items.length === 0
        ? "No agents are running"
        : [
            unreadCount > 0 ? `${unreadCount.toLocaleString()} unread` : null,
            needsYou > 0 ? `${pluralize(needsYou, "needs", "need")} you` : null,
            pluralize(items.length, "agent"),
          ]
            .filter(Boolean)
            .join(" · ");

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      size="workspace"
      maxHeight="h-[min(90vh,1100px)]"
      // The first control takes focus at once — with no rows to land on, the
      // keyboard would otherwise stay on whatever opened the panel.
      initialFocus="first"
      restoreFocusTo={() => focusAfterCloseRef.current}
      preferRestoreFocusTo
      data-testid="triage-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<ScanEye />}>Triage</AppDialog.Title>
        <span className="ml-3 min-w-0 flex-1 truncate text-sm text-text-secondary">
          {summaryLine}
        </span>
        {triage?.refreshedAt ? (
          <span className="shrink-0 text-xs text-text-secondary">
            <TimeAgo timestamp={triage.refreshedAt} now={nowMs} prefix="Scanned " />
          </span>
        ) : null}
        <Button
          ref={refreshRef}
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
        {shortcut && <KbdChord shortcut={shortcut} className="shrink-0" />}
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div
        ref={bodyRef}
        className="flex min-h-0 flex-1 flex-col gap-3 p-3"
        onKeyDown={onNavigationKeyDown}
        onFocusCapture={(event) =>
          setTyping(event.target instanceof Element && event.target.closest(".cm-editor") !== null)
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
            Add your TypeSafe and Cerebras keys in Settings to read each agent's screen. Until then
            the list shows only what Daintree's own state tracking saw.
          </Callout>
        )}
        {triage?.lastError && (
          <Callout severity="warning" size="compact" title="Some screens couldn't be read">
            {triage.lastError}. Refresh to try them again.
          </Callout>
        )}
        {items.length > 0 && (
          // An inbox: what needs you down the left, most urgent first, and the
          // selected agent's own terminal on the right to act in.
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)] gap-3">
            <div
              role="listbox"
              aria-label="Agents"
              className="flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-1"
              data-triage-list=""
            >
              {items.map((item) => (
                <TriageRow
                  key={item.runId}
                  item={item}
                  domId={triageCardDomId(item.runId)}
                  isSelected={focusedItem?.runId === item.runId}
                  unread={isUnread(item)}
                  onSelect={() => setFocusedId(item.runId)}
                  onClick={() => openedByUser(item)}
                  onOpen={() => handlers.onOpen(item)}
                />
              ))}
            </div>
            <div className="flex min-h-0 flex-col rounded-[var(--radius-lg)] border border-border-default bg-surface-panel p-3">
              {focusedItem && (
                <TriageCard
                  key={focusedItem.runId}
                  ref={detailRef}
                  item={focusedItem}
                  domId={`triage-detail-${focusedItem.runId}`}
                  scanning={busy}
                  {...handlers}
                />
              )}
            </div>
          </div>
        )}
        {fleet !== null && items.length === 0 && (
          <p className="px-1 py-6 text-center text-sm text-text-secondary">
            Launch an agent and it shows up here.
          </p>
        )}
      </div>

      <AppDialog.Footer>
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
      </AppDialog.Footer>
    </AppDialog>
  );
}
