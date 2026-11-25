import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notify";

interface KeptChoice {
  lane: string;
  keep: boolean;
}

/**
 * Whether a project's Assistant lane is kept running across restarts
 * (#18177), as main holds it: read for the lane on screen, and again on
 * `refresh`, since a Stop turns it off without this view saying so. Null
 * while unread and with no project. Only the latest read or change lands, so
 * an answer for an earlier one can't undo a later one.
 */
export function useLaneKeepRunning(
  projectId: string | null,
  slot: number
): {
  keepRunning: boolean | null;
  setKeepRunning: (keep: boolean) => void;
  refresh: () => void;
} {
  const lane = projectId === null ? null : `${projectId}\u0000${slot}`;
  const [choice, setChoice] = useState<KeptChoice | null>(null);
  const [reads, setReads] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (projectId === null || lane === null) return;
    const asked = ++latest.current;
    const read = window.electron.help.getKeepRunning?.(projectId, slot);
    void read?.then(
      (keep) => {
        if (latest.current === asked) setChoice({ lane, keep });
      },
      () => {}
    );
  }, [projectId, slot, lane, reads]);

  const refresh = useCallback(() => setReads((count) => count + 1), []);

  const setKeepRunning = useCallback(
    (keep: boolean) => {
      if (projectId === null || lane === null) return;
      const save = () => {
        const asked = ++latest.current;
        setChoice({ lane, keep });
        const change = window.electron.help.setKeepRunning?.(projectId, slot, keep);
        void change?.then(
          (held) => {
            if (latest.current === asked) setChoice({ lane, keep: held });
          },
          () => {
            if (latest.current === asked) setReads((count) => count + 1);
            // Held in main, but a crash before its next save would forget it.
            notify({
              type: "error",
              title: "Couldn't save keep running across restarts",
              message: "Daintree holds the choice and saves it with its next change.",
              context: { eventKind: "settings" },
              action: { label: "Retry", onClick: save },
            });
          }
        );
      };
      save();
    },
    [projectId, slot, lane]
  );

  return {
    keepRunning: choice !== null && choice.lane === lane ? choice.keep : null,
    setKeepRunning,
    refresh,
  };
}
