import { useEffect, useState } from "react";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

function withSession(
  sessions: readonly GlobalAssistantView[] | null,
  next: GlobalAssistantView
): GlobalAssistantView[] {
  const others = (sessions ?? []).filter((session) => session.slot !== next.slot);
  return [...others, next].sort((a, b) => a.slot - b.slot);
}

/**
 * Every global assistant session the machine may hold (#18142), as main last
 * told this view, first session first: read once, then kept current by each
 * change. Only read and listened to: nothing here attaches to, starts or
 * stops a session. Null while `enabled` is false or until the listing has
 * answered: a change heard before it names one session, never both.
 */
export function useGlobalAssistantSessions(
  enabled: boolean
): readonly GlobalAssistantView[] | null {
  const [sessions, setSessions] = useState<readonly GlobalAssistantView[] | null>(null);
  const [listed, setListed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const help = window.electron?.help;
    // Nothing to list from: known as none, so nothing waits on it.
    if (!help?.listGlobalAssistantSessions) {
      setSessions([]);
      setListed(true);
      return;
    }
    let disposed = false;
    // A change and the listing don't share an ordering on the way here, and a
    // change carries the session's whole state: the listing never undoes one.
    const told = new Set<number>();
    const off = help.onGlobalAssistantChanged((state) => {
      if (disposed) return;
      told.add(state.slot);
      setSessions((current) => withSession(current, state));
    });
    help.listGlobalAssistantSessions().then(
      (answer) => {
        if (disposed) return;
        setSessions((current) =>
          answer.reduce<GlobalAssistantView[]>(
            (merged, session) => (told.has(session.slot) ? merged : withSession(merged, session)),
            [...(current ?? [])]
          )
        );
        setListed(true);
      },
      () => {
        if (disposed) return;
        setSessions((current) => current ?? []);
        setListed(true);
      }
    );
    return () => {
      disposed = true;
      off();
      setSessions(null);
      setListed(false);
    };
  }, [enabled]);

  return enabled && listed ? sessions : null;
}
