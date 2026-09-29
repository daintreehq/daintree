import { useEffect, useState } from "react";

/**
 * True while any `worktree.refresh` dispatch is in flight, counted off the
 * action's own start/settled window events. Overlapping refreshes keep it true
 * until the last one settles; a settle with no matching start (a refresh that
 * began before this mounted) never drives the count below zero.
 */
export function useDispatchedSidebarRefresh(): boolean {
  const [inFlight, setInFlight] = useState(0);
  useEffect(() => {
    const onStart = () => setInFlight((n) => n + 1);
    const onSettled = () => setInFlight((n) => Math.max(0, n - 1));
    window.addEventListener("daintree:refresh-sidebar", onStart);
    window.addEventListener("daintree:refresh-sidebar-settled", onSettled);
    return () => {
      window.removeEventListener("daintree:refresh-sidebar", onStart);
      window.removeEventListener("daintree:refresh-sidebar-settled", onSettled);
    };
  }, []);
  return inFlight > 0;
}
