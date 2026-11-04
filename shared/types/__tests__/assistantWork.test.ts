import { describe, expect, it } from "vitest";
import {
  assistantWorkForLanes,
  type AssistantWorkHostReading,
  type AssistantWorkHostRef,
  type AssistantWorkHostWorker,
} from "../assistantWork.js";

const assistant = (lane: number): AssistantWorkHostRef => ({
  kind: "assistant",
  subject: {
    hostId: "local",
    scope: { kind: "project", projectId: "p" },
    terminalId: `a${lane}`,
    incarnation: 1,
    lane,
  },
});

const worker = (
  terminalId: string,
  createdBy: AssistantWorkHostRef | null,
  controlledBy: AssistantWorkHostRef | null
): AssistantWorkHostWorker => ({
  terminalId,
  projectId: "p",
  incarnation: 1,
  spawnedAt: 1,
  createdBy,
  controlledBy,
  control: controlledBy ? "creation" : null,
});

const reading = (workers: AssistantWorkHostWorker[]): AssistantWorkHostReading => ({
  coverage: "ok",
  observedAt: 1,
  complete: true,
  omitted: 2,
  workers,
});

describe("assistantWorkForLanes (#16218)", () => {
  it("leaves out a worker either of whose assistants sits past the count, and counts it", () => {
    const fitted = assistantWorkForLanes(
      reading([
        worker("made-high", assistant(4), assistant(0)),
        worker("held-high", assistant(0), assistant(3)),
        worker("low", assistant(2), assistant(2)),
        worker("relayed", { kind: "relay", senderId: "ab", sessionKey: "cd" }, { kind: "ended" }),
        worker("free", null, null),
      ]),
      3
    );
    expect(fitted.workers.map((w) => w.terminalId)).toEqual(["low", "relayed", "free"]);
    expect(fitted.omitted).toBe(4);
  });

  it("returns a reading with nothing past the count unchanged", () => {
    const within = reading([worker("low", assistant(0), assistant(2))]);
    expect(assistantWorkForLanes(within, 3)).toBe(within);
  });
});
