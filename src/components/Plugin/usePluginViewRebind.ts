import { useEffect, useRef, type ComponentType, type RefObject } from "react";
import type { PanelViewProps, PluginRuntimeStatus } from "@shared/types/plugin";

/**
 * Rebinds a mounted plugin view when what it was built against changes: its
 * builtin slot, or the worker generation behind it. Both discard the attempt
 * through the content's single `replaceAttempt` path. Returns the worker
 * generation the current attempt is bound to, which a plugin-initiated reload
 * reads to defer to a pending rebind.
 */
export function usePluginViewRebind({
  builtinComponent,
  builtinDisabled,
  worker,
  replaceAttempt,
  boundaryShowingError,
  lastErrorWasImportStage,
}: {
  builtinComponent: ComponentType<PanelViewProps> | null;
  builtinDisabled: boolean;
  worker: PluginRuntimeStatus["worker"];
  replaceAttempt: (requestRecoveryPath: boolean) => void;
  boundaryShowingError: RefObject<boolean>;
  lastErrorWasImportStage: RefObject<boolean>;
}): RefObject<number | null> {
  // The path this attempt was built for. A change — a slot registering after
  // mount, a builtin re-registering its component, or its plugin toggling —
  // discards the attempt through the same single path a retry uses, so the
  // outgoing view's `disposeSignal` aborts and the boundary remounts. The
  // first observation adopts silently, like the worker generation below.
  const boundBuiltinPath = useRef<{
    component: ComponentType<PanelViewProps> | null;
    disabled: boolean;
  } | null>(null);
  useEffect(() => {
    const previous = boundBuiltinPath.current;
    boundBuiltinPath.current = { component: builtinComponent, disabled: builtinDisabled };
    if (previous === null) return;
    if (previous.component === builtinComponent && previous.disabled === builtinDisabled) return;
    replaceAttempt(false);
  }, [builtinComponent, builtinDisabled, replaceAttempt]);

  /**
   * Worker generation this attempt is bound to.
   *
   * A ref, not state: it must be read and written inside the effect that
   * decides whether to rebind, and re-rendering on it would achieve nothing.
   * `null` until a `ready` worker has been seen at all, so the FIRST
   * observation adopts the generation silently — a panel that mounts against
   * an already-running backend must not treat that backend as a replacement
   * and immediately remount itself.
   */
  const boundWorkerGeneration = useRef<number | null>(null);
  useEffect(() => {
    if (!worker || worker.state !== "ready") return;
    const previous = boundWorkerGeneration.current;
    // Already bound to this backend. Checked before the write, so a repeated
    // `ready` for one generation can never replace the attempt twice — which
    // is also what keeps the failed-view branch below from looping.
    if (previous === worker.generation) return;
    boundWorkerGeneration.current = worker.generation;
    // The first `ready` this panel has seen, on a view that is fine: adopt the
    // generation silently. A panel mounting against an already-running backend
    // must not read that backend as a replacement and throw its view away.
    //
    // A FAILED view is the exception, and the case that made this branch
    // conditional rather than unconditional: when the initial activation is
    // what failed, this panel never observed a `ready` at all, so treating
    // "first observation" as "nothing to do" would clear the banner and leave
    // the user staring at the original error with the backend now healthy.
    if (previous === null && !boundaryShowingError.current) return;
    // A different generation is ready: the backend this view was talking to is
    // gone and a new one is live. Every panel on the instance runs this from
    // the same broadcast, which is what makes them move together — no
    // main-side panel registry is involved (#12278).
    //
    // A view whose module fetch is what failed needs a fresh generation just
    // as "Try again" does: remounting would re-import the specifier the module
    // map already holds as failed (#12996).
    replaceAttempt(boundaryShowingError.current && lastErrorWasImportStage.current);
  }, [worker, replaceAttempt]);

  return boundWorkerGeneration;
}
