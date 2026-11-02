import { useCallback, useEffect, useRef, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";

/**
 * How many answers need a person (#16020), for Settings to say: read when the
 * section shows, and again each time the list closes. `loading` until the
 * first read lands, `failed` when it couldn't be read, `not-running` while
 * Decisions isn't delivering; the list stays reachable in every one of them.
 */
export type DecisionsAttentionCount =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "not-running" }
  | { state: "counted"; count: number };

export function useDecisionsAttentionCount(): DecisionsAttentionCount {
  const [count, setCount] = useState<DecisionsAttentionCount>({ state: "loading" });
  const listOpen = useDecisionsAttentionStore((state) => state.isOpen);
  const reading = useRef(0);

  const read = useCallback(() => {
    const ticket = ++reading.current;
    let read: ReturnType<typeof decisionsClient.listAttention>;
    try {
      read = decisionsClient.listAttention();
    } catch {
      // A bridge without the read can't count; the list stays reachable.
      setCount({ state: "failed" });
      return;
    }
    read.then(
      (list) => {
        if (ticket !== reading.current) return;
        setCount(
          list.result === "listed"
            ? { state: "counted", count: list.items.length }
            : { state: "not-running" }
        );
      },
      () => {
        if (ticket === reading.current) setCount({ state: "failed" });
      }
    );
  }, []);

  useEffect(() => {
    if (!listOpen) read();
  }, [listOpen, read]);

  return count;
}
