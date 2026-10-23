// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_PAGE_HTML } from "../deviceAnswerPage.js";

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const run = (overrides: Record<string, unknown>) => ({
  runId: "run-1",
  spawnedAt: 100,
  project: "web",
  title: null,
  agentId: "claude",
  agentState: "waiting",
  waitingReason: "approval",
  since: null,
  parked: false,
  snoozed: false,
  screen: "❯ 1. Yes\n  2. No",
  choices: ["Yes", "No"],
  ...overrides,
});

let sent: Sent[];

/** Load the page as a paired device would, its own script and all, served `waiting` and `answer`. */
async function openPage(
  waiting: unknown,
  answer: () => Promise<unknown> = async () => ({ ok: true })
): Promise<void> {
  const page = new DOMParser().parseFromString(DEVICE_PAGE_HTML, "text/html");
  const script = page.querySelector("script")!.textContent!;
  page.querySelector("script")!.remove();
  document.body.innerHTML = page.body.innerHTML;
  localStorage.setItem("daintree-device-token", "t".repeat(32));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: { method: string; body?: string }) => {
      sent.push({
        method: init.method,
        path,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      const data = path.startsWith("/api/waiting") ? waiting : await answer();
      return { ok: true, status: 200, json: async () => data };
    })
  );
  new Function(script)();
  await vi.advanceTimersByTimeAsync(0);
}

function button(card: Element, label: string): HTMLButtonElement {
  return [...card.querySelectorAll("button")].find((b) => b.textContent === label)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("the paired device's page", () => {
  it("names each run's machine once a host is connected, and answers it on that machine", async () => {
    await openPage({
      runs: [
        run({ hostId: "local", host: "greg-studio" }),
        run({ hostId: "studio-03", host: "studio-03", project: "api" }),
      ],
      hosts: [
        { hostId: "studio-03", host: "studio-03", status: "ok" },
        { hostId: "studio-04", host: "studio-04", status: "needs-update" },
      ],
    });
    // Hosts' runs are asked for only by a page that can answer them there.
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/waiting?hosts=1" });
    const cards = [...document.querySelectorAll(".run")];
    expect(cards.map((card) => card.querySelector(".host")?.textContent)).toEqual([
      "greg-studio",
      "studio-03",
    ]);
    expect(document.getElementById("hosts")!.textContent).toContain(
      "studio-04 needs a newer Daintree"
    );

    button(cards[1]!, "No").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toEqual({
      method: "POST",
      path: "/api/answer",
      body: { hostId: "studio-03", runId: "run-1", spawnedAt: 100, label: "No" },
    });
  });

  it("names no machine when only this one's runs are listed, as an older Daintree sends them", async () => {
    await openPage({ runs: [run({})] });
    const card = document.querySelector(".run")!;
    expect(card.querySelector(".host")).toBeNull();

    button(card, "Yes").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)!.body).toEqual({ runId: "run-1", spawnedAt: 100, label: "Yes" });
  });

  it("keeps the runs it can answer when what it's told of hosts can't be read", async () => {
    await openPage({ runs: [run({ hostId: "local", host: "greg-studio" })], hosts: [null, 7] });
    expect(document.querySelectorAll(".run")).toHaveLength(1);
    expect(document.getElementById("status")!.textContent).toBe("");
  });

  const emptyText = () => {
    const empty = document.getElementById("empty")!;
    return empty.hidden ? null : empty.textContent;
  };

  it("says no agent is waiting only when every host was read", async () => {
    await openPage({
      runs: [],
      hosts: [{ hostId: "studio-03", host: "Studio", status: "ok" }],
    });
    expect(emptyText()).toBe("No agent is waiting.");
    expect(document.getElementById("hosts")!.textContent).toBe("");
  });

  it("says no agent is waiting when it's told of no hosts, as an older Daintree sends it", async () => {
    await openPage({ runs: [] });
    expect(emptyText()).toBe("No agent is waiting.");
  });

  it.each([
    ["not-connected", "Not connected to Mini, so its agents aren't shown."],
    ["unreachable", "Couldn't read the waiting agents on Mini."],
    ["needs-update", "Mini needs a newer Daintree to show its waiting agents here."],
  ])("names only the machines it read when a host is %s", async (status, note) => {
    await openPage({
      runs: [],
      hosts: [
        { hostId: "studio-03", host: "Studio", status: "ok" },
        { hostId: "mini", host: "Mini", status },
      ],
    });
    expect(emptyText()).toBe("No agent is waiting on this computer or Studio.");
    expect(document.getElementById("hosts")!.textContent).toBe(note);
  });

  it("names only this computer when no host could be read", async () => {
    await openPage({
      runs: [],
      hosts: [
        { hostId: "mini", host: "Mini", status: "not-connected" },
        { hostId: "studio-04", host: "studio-04", status: "unreachable" },
      ],
    });
    expect(emptyText()).toBe("No agent is waiting on this computer.");
    const notes = document.getElementById("hosts")!.textContent;
    expect(notes).toContain("Not connected to Mini");
    expect(notes).toContain("studio-04");
  });

  it("lists every machine it read", async () => {
    await openPage({
      runs: [],
      hosts: [
        { hostId: "a", host: "Studio", status: "ok" },
        { hostId: "b", host: "Laptop", status: "ok" },
        { hostId: "mini", host: "Mini", status: "not-connected" },
      ],
    });
    expect(emptyText()).toBe("No agent is waiting on this computer, Studio or Laptop.");
  });

  it("hides the empty state but keeps the notes while runs are listed", async () => {
    await openPage({
      runs: [run({ hostId: "local", host: "greg-studio" })],
      hosts: [{ hostId: "mini", host: "Mini", status: "not-connected" }],
    });
    expect(emptyText()).toBeNull();
    expect(document.getElementById("hosts")!.textContent).toContain("Not connected to Mini");
  });

  it("never says nothing was pressed when the reply to an answer was lost", async () => {
    await openPage({ runs: [run({ hostId: "studio-03", host: "studio-03" })], hosts: [] }, () =>
      Promise.reject(new Error("network"))
    );
    const card = document.querySelector(".run")!;
    button(card, "Yes").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(card.querySelector(".result")!.textContent).toContain("may have been pressed");
  });
});
