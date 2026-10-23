import { describe, expect, it } from "vitest";
import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { AssistantWorkReading, AssistantWorkWorker } from "@shared/types/assistantWork";
import { allHostsKey } from "../canopyAllHosts";
import { canopyAssistantId } from "../canopyAssistants";
import type { CanopyItem } from "../canopyModel";
import {
  hostsWithPartialWork,
  isWorkOf,
  workLinkLabel,
  workLinkOf,
  workLinksByRun,
} from "../canopyRelationships";

const ASSISTANT: AgentDirectorySubject = {
  hostId: "local",
  scope: { kind: "project", projectId: "p1" },
  terminalId: "a-pty",
  incarnation: 3,
  lane: 0,
};
const OTHER: AgentDirectorySubject = { ...ASSISTANT, lane: 1, terminalId: "b-pty" };
const mine = { kind: "assistant" as const, subject: ASSISTANT };
const other = { kind: "assistant" as const, subject: OTHER };

function worker(overrides: Partial<AssistantWorkWorker> = {}): AssistantWorkWorker {
  return {
    terminalId: "w1",
    projectId: "p1",
    incarnation: 1,
    spawnedAt: 100,
    createdBy: mine,
    controlledBy: mine,
    control: "creation",
    ...overrides,
  };
}

function reading(
  workers: AssistantWorkWorker[],
  overrides: Partial<AssistantWorkReading> = {}
): AssistantWorkReading {
  return { coverage: "ok", observedAt: 1, complete: true, omitted: 0, workers, ...overrides };
}

function item(runId: string, spawnedAt = 100): CanopyItem {
  return { runId, row: { run: { spawnedAt } } } as unknown as CanopyItem;
}

const names = (subject: AgentDirectorySubject) =>
  canopyAssistantId(subject) === canopyAssistantId(ASSISTANT) ? "Daintree Assistant · p1" : null;

describe("workLinksByRun", () => {
  it("keeps the same terminal id on two hosts apart under All hosts", () => {
    const links = workLinksByRun(
      new Map([
        ["local", reading([worker({ terminalId: "t1" })])],
        ["host-b", reading([worker({ terminalId: "t1", createdBy: other, controlledBy: null })])],
      ]),
      allHostsKey
    );
    const here = workLinkOf(item(allHostsKey("local", "t1")), links);
    const there = workLinkOf(item(allHostsKey("host-b", "t1")), links);
    expect(isWorkOf(here, canopyAssistantId(ASSISTANT))).toBe(true);
    expect(isWorkOf(there, canopyAssistantId(ASSISTANT))).toBe(false);
    expect(isWorkOf(there, canopyAssistantId(OTHER))).toBe(true);
  });

  it("never lends a link to a later run under a reused id", () => {
    const links = workLinksByRun(new Map([["local", reading([worker()])]]), (_h, id) => id);
    expect(workLinkOf(item("w1", 100), links)).not.toBeNull();
    expect(workLinkOf(item("w1", 200), links)).toBeNull();
  });
});

describe("isWorkOf", () => {
  const id = canopyAssistantId(ASSISTANT);

  it("takes what it created and what it was handed, and nothing else", () => {
    expect(isWorkOf(worker(), id)).toBe(true);
    expect(
      isWorkOf(
        worker({ createdBy: { kind: "ended" }, controlledBy: mine, control: "handover" }),
        id
      )
    ).toBe(true);
    expect(isWorkOf(worker({ createdBy: mine, controlledBy: null, control: null }), id)).toBe(true);
    expect(isWorkOf(worker({ createdBy: other, controlledBy: other }), id)).toBe(false);
    expect(isWorkOf(null, id)).toBe(false);
  });

  it("is never the work of a successor run in the same lane", () => {
    const successor = canopyAssistantId({ ...ASSISTANT, terminalId: "a-pty-2", incarnation: 4 });
    expect(isWorkOf(worker(), successor)).toBe(false);
  });
});

describe("workLinkLabel", () => {
  it("says who started it and nothing more while its creator holds it", () => {
    expect(workLinkLabel(worker(), names)).toBe("Started by Daintree Assistant · p1");
  });

  it("keeps creation apart from a hand-over", () => {
    expect(
      workLinkLabel(
        worker({ createdBy: { kind: "ended" }, controlledBy: mine, control: "handover" }),
        names
      )
    ).toBe("Started by an assistant that has ended · Handed to Daintree Assistant · p1");
  });

  it("says a live creator no longer controls it", () => {
    expect(workLinkLabel(worker({ controlledBy: null, control: null }), names)).toBe(
      "Started by Daintree Assistant · p1 · No longer under its control"
    );
  });

  it("names another installation's assistant as such, never as one of ours", () => {
    expect(
      workLinkLabel(
        worker({ createdBy: { kind: "other-installation" }, controlledBy: null, control: null }),
        names
      )
    ).toBe("Started by another installation's assistant");
    expect(workLinkLabel(null, names)).toBeNull();
  });
});

describe("hostsWithPartialWork", () => {
  it("counts every host not read in full, unread ones included", () => {
    const readings = new Map([
      ["local", reading([])],
      ["host-b", reading([], { coverage: "unreachable", complete: false })],
      ["host-c", reading([], { omitted: 2 })],
    ]);
    expect(hostsWithPartialWork(readings, ["local", "host-b", "host-c", "host-d"])).toEqual([
      "host-b",
      "host-c",
      "host-d",
    ]);
  });
});
