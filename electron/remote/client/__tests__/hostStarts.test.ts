import { describe, expect, it } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import { HostStarts } from "../hostStarts.js";
import { TransportError } from "../transport.js";

const studio = { kind: "ssh", target: "studio" } as const;
const signal = () => new AbortController().signal;

describe("HostStarts", () => {
  it("never reads as starting while a host is only checked on, whatever the check finds", async () => {
    for (const outcome of ["not-startable", "listening"] as const) {
      let answer!: () => void;
      const changes: string[] = [];
      const starts = new HostStarts({
        setup: {
          ensureHostRunning: () =>
            new Promise((resolve) => {
              answer = () => resolve(outcome);
            }),
        },
        onChange: (hostId) => changes.push(hostId),
      });
      const ensuring = starts.ensureRunning("studio-01", studio, signal());
      expect(starts.isStarting("studio-01")).toBe(false);
      answer();
      await expect(ensuring).resolves.toBe(outcome === "listening");
      expect(starts.isStarting("studio-01")).toBe(false);
      expect(changes).toEqual([]);
    }
  });

  it("reads as starting from the start command until it settles, however it ends", async () => {
    for (const ending of ["started", "failed"] as const) {
      let finish!: () => void;
      const seen: boolean[] = [];
      const starts: HostStarts = new HostStarts({
        setup: {
          async ensureHostRunning(_connection, _signal, onStart) {
            onStart?.();
            await new Promise<void>((resolve) => (finish = resolve));
            if (ending === "failed") {
              throw new AppError({
                code: "INTERNAL",
                message: "no session",
                userMessage: "Log in on studio",
              });
            }
            return "started";
          },
        },
        onChange: (hostId) => seen.push(starts.isStarting(hostId)),
      });
      const ensuring = starts.ensureRunning("studio-01", studio, signal());
      expect(starts.isStarting("studio-01")).toBe(true);
      expect(starts.isStarting("mini-02")).toBe(false);
      finish();
      if (ending === "started") {
        await expect(ensuring).resolves.toBe(true);
      } else {
        const error = await ensuring.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TransportError);
        expect(error).toMatchObject({ detail: "Log in on studio" });
      }
      expect(starts.isStarting("studio-01")).toBe(false);
      expect(seen).toEqual([true, false]);
    }
  });
});
