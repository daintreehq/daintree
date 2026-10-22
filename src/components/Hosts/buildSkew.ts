import type { HandshakeMismatch, HostId } from "@shared/types/remoteHosts";
import { notify } from "@/lib/notify";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { updateActionLabel, updateTargetFor } from "./hostModel";
import { runHostUpdate } from "./hostUpdate";

/** The update the build warning offers: the side that's behind. */
export interface BuildSkewUpdate {
  label: string;
  onClick: () => void;
}

type HostConnectionSnapshot = ReturnType<typeof useHostConnectionStore.getState>;

function viewMismatch(state: HostConnectionSnapshot): HandshakeMismatch | undefined {
  return state.connection?.status === "connected" ? state.connection.buildMismatch : undefined;
}

function updateFor(
  hostId: HostId | null,
  hostName: string | null,
  mismatch: HandshakeMismatch | undefined
): BuildSkewUpdate | null {
  if (hostId === null || mismatch === undefined) return null;
  return {
    label: updateActionLabel(mismatch, hostName ?? hostId),
    onClick: () => runHostUpdate(updateTargetFor(mismatch), hostId),
  };
}

/** That update for this view's host while it runs another build; null otherwise. */
export function useBuildSkewUpdate(): BuildSkewUpdate | null {
  const hostId = useHostConnectionStore((s) => s.hostId);
  const hostName = useHostConnectionStore((s) => s.hostName);
  const mismatch = useHostConnectionStore(viewMismatch);
  return updateFor(hostId, hostName, mismatch);
}

const noticed = new Set<string>();

interface HeldNotice {
  message: string;
  stillTrue: () => boolean;
  unsubscribe: () => void;
}

/** Notices held for the view to hear how its link stands, by title: the latest failure for each. */
const awaitingLink = new Map<string, HeldNotice>();

/**
 * Something this view shows didn't load because its host's build doesn't
 * have it: `message` is the Shell's account of the two builds. Once per thing
 * per host build in this view, in the grid bar since nothing on screen failed
 * visibly, and filed with the build warning it follows up on. `stillTrue`
 * says whether the failure still stands, for a notice that has to wait.
 */
export function noticeBuildSkew(
  title: string,
  message: string,
  stillTrue: () => boolean = () => true
): void {
  const state = useHostConnectionStore.getState();
  if (state.connection?.status !== "connected") {
    // The call can fail before this view has heard how its link stands; say
    // it once the view has, if the failure stands and the builds still differ.
    const held = awaitingLink.get(title);
    if (held) {
      held.message = message;
      held.stillTrue = stillTrue;
      return;
    }
    const unsubscribe = useHostConnectionStore.subscribe((next) => {
      if (next.connection?.status !== "connected") return;
      const notice = awaitingLink.get(title);
      unsubscribe();
      awaitingLink.delete(title);
      if (notice?.stillTrue()) noticeBuildSkew(title, notice.message, notice.stillTrue);
    });
    awaitingLink.set(title, { message, stillTrue, unsubscribe });
    return;
  }
  const update = updateFor(state.hostId, state.hostName, viewMismatch(state));
  if (update === null || state.connection?.status !== "connected") return;
  const { version, commit } = state.connection.handshake;
  const key = `${state.hostId}\u0000${version}\u0000${commit}\u0000${title}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  notify({
    type: "warning",
    placement: "grid-bar",
    context: { eventKind: "connectivity" },
    supersedeKey: `host-build-mismatch:${state.hostId}`,
    title,
    message,
    action: update,
  });
}

export function _resetBuildSkewNoticesForTesting(): void {
  noticed.clear();
  for (const { unsubscribe } of awaitingLink.values()) unsubscribe();
  awaitingLink.clear();
}
