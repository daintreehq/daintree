import { useCallback, useEffect, useRef, useState } from "react";

import { advanceMruIndex, getMruProjects } from "@/lib/projectMru";
import { notify } from "@/lib/notify";
import { useProjectStore } from "@/store/projectStore";
import type { Project } from "@shared/types";

import { useEscapeStack } from "./useEscapeStack";

const HOLD_THRESHOLD_MS = 120;

export interface UseProjectMruSwitcherReturn {
  isVisible: boolean;
  projects: Project[];
  selectedIndex: number;
}

interface SessionState {
  active: boolean;
  holding: boolean;
  hasTriggerKey: boolean;
  selectedIndex: number;
  projects: Project[];
}

function createIdleSession(): SessionState {
  return {
    active: false,
    holding: false,
    hasTriggerKey: false,
    selectedIndex: 1,
    projects: [],
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm") !== null) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Hold-scrub MRU project switcher.
 *
 * Tap Cmd+Alt+- (or Cmd+Alt+=): switch to the most recent other project.
 * Hold Cmd+Alt+-/= for >120ms: show an overlay that scrubs through the MRU
 * list with each additional '-' (older) or '=' (newer) keypress. Release
 * Cmd/Alt to commit; Escape or window blur to cancel.
 *
 * Uses capture-phase window listeners so the event fires before xterm's
 * custom key handler and before `KeybindingService` dispatches the matching
 * action. Call `stopPropagation` + `preventDefault` on handled events to
 * prevent double-dispatch.
 */
export function useProjectMruSwitcher(): UseProjectMruSwitcherReturn {
  const [overlay, setOverlay] = useState<{
    visible: boolean;
    selectedIndex: number;
    projects: Project[];
  }>({ visible: false, selectedIndex: 1, projects: [] });

  const sessionRef = useRef<SessionState>(createIdleSession());
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSession = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    sessionRef.current = createIdleSession();
    setOverlay((prev) =>
      prev.visible ? { visible: false, selectedIndex: 1, projects: [] } : prev
    );
  }, []);

  const commitSelection = useCallback((session: SessionState) => {
    const snapshotTarget = session.projects[session.selectedIndex];
    if (!snapshotTarget) return;
    const state = useProjectStore.getState();
    const liveTarget = state.projects.find((p) => p.id === snapshotTarget.id);
    if (!liveTarget) return;
    if (state.currentProject?.id === liveTarget.id) return;
    const switchFn = liveTarget.status === "background" ? state.reopenProject : state.switchProject;
    Promise.resolve(switchFn(liveTarget.id)).catch((error) => {
      notify({
        type: "error",
        title: "Failed to switch project",
        message: error instanceof Error ? error.message : "Unknown error",
        duration: 5000,
      });
    });
  }, []);

  useEscapeStack(overlay.visible, cancelSession);

  useEffect(() => {
    const startHoldTimer = () => {
      if (holdTimerRef.current !== null) return;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        const session = sessionRef.current;
        if (!session.active) return;
        session.holding = true;
        setOverlay({
          visible: true,
          selectedIndex: session.selectedIndex,
          projects: session.projects,
        });
      }, HOLD_THRESHOLD_MS);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!event.metaKey || !event.altKey) return;
      const isOlder = event.code === "Minus";
      const isNewer = event.code === "Equal";
      if (!isOlder && !isNewer) return;

      if (isEditableTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const state = useProjectStore.getState();
      const currentId = state.currentProject?.id ?? null;
      if (!currentId) return;
      const sortedAll = getMruProjects(state.projects);
      const current = sortedAll.find((p) => p.id === currentId);
      if (!current) return;
      const sorted = [current, ...sortedAll.filter((p) => p.id !== currentId)];

      if (sorted.length < 2) return;

      const session = sessionRef.current;
      if (!session.active) {
        sessionRef.current = {
          active: true,
          holding: false,
          hasTriggerKey: true,
          selectedIndex: 1,
          projects: sorted,
        };
        startHoldTimer();
        return;
      }

      session.hasTriggerKey = true;
      session.projects = sorted;
      const newIndex = advanceMruIndex(
        session.selectedIndex,
        isOlder ? "older" : "newer",
        sorted.length
      );
      session.selectedIndex = newIndex;
      if (session.holding) {
        setOverlay({
          visible: true,
          selectedIndex: newIndex,
          projects: sorted,
        });
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Meta" && event.key !== "Alt") return;
      const session = sessionRef.current;
      if (!session.active) return;

      if (session.hasTriggerKey) {
        commitSelection(session);
      }
      cancelSession();
    };

    const handleBlur = () => {
      cancelSession();
    };

    const handleVisibility = () => {
      if (document.hidden) cancelSession();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, [cancelSession, commitSelection]);

  return {
    isVisible: overlay.visible,
    projects: overlay.projects,
    selectedIndex: overlay.selectedIndex,
  };
}
