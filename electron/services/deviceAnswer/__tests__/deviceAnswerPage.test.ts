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
  questionId: "question-of-run-1-0001",
  ...overrides,
});

let sent: Sent[];
// How the next list reads go: answered, unreachable, or refused as unpaired.
let waitingReply: "ok" | "unreachable" | "error" | "pending" | 401;
// Settles a list read left pending, as answered or unreachable.
let settlePending: (outcome: "ok" | "unreachable") => void;

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
      if (path.startsWith("/api/waiting")) {
        if (waitingReply === "unreachable") throw new TypeError("Failed to fetch");
        if (waitingReply === "pending") {
          return new Promise((resolve, reject) => {
            settlePending = (outcome) =>
              outcome === "ok"
                ? resolve({ ok: true, status: 200, json: async () => waiting })
                : reject(new TypeError("Failed to fetch"));
          });
        }
        if (waitingReply === "error") {
          return { ok: false, status: 503, json: async () => ({ error: "Daintree is busy." }) };
        }
        if (waitingReply === 401) {
          return { ok: false, status: 401, json: async () => ({ error: "Not paired." }) };
        }
        return { ok: true, status: 200, json: async () => waiting };
      }
      const data = await answer();
      return { ok: true, status: 200, json: async () => data };
    })
  );
  new Function(script)();
  await vi.advanceTimersByTimeAsync(0);
}

/** The device's own clock reading, as the page writes it. */
function hhmm(ms: number): string {
  const at = new Date(ms);
  return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
}

function answerButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("#runs button")];
}

const status = () => document.getElementById("status")!.textContent;

function button(card: Element, label: string): HTMLButtonElement {
  return [...card.querySelectorAll("button")].find((b) => b.textContent === label)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  waitingReply = "ok";
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
        run({ hostId: "local", host: "greg-studio", questionId: "question-of-local-run-01" }),
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
    expect(cards.map((card) => card.querySelector(".where")?.textContent)).toEqual([
      "greg-studio · Claude",
      "studio-03 · Claude",
    ]);
    expect(document.getElementById("hosts")!.textContent).toContain(
      "studio-04 needs a newer Daintree"
    );

    button(cards[1]!, "No").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toEqual({
      method: "POST",
      path: "/api/answer",
      body: {
        hostId: "studio-03",
        runId: "run-1",
        spawnedAt: 100,
        label: "No",
        questionId: "question-of-run-1-0001",
      },
    });
  });

  it("names no machine when only this one's runs are listed, as an older Daintree sends them", async () => {
    await openPage({ runs: [run({})] });
    const card = document.querySelector(".run")!;
    expect(card.querySelector(".where")!.textContent).toBe("Claude");

    button(card, "Yes").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)!.body).toEqual({
      runId: "run-1",
      spawnedAt: 100,
      label: "Yes",
      questionId: "question-of-run-1-0001",
    });
  });

  it("answers with the question the card shows now, though its options read the same", async () => {
    const waiting = {
      runs: [
        run({
          screen: "Run rm -rf build?\n❯ 1. Yes\n  2. No",
          questionId: "question-a-0000000001",
        }),
      ],
    };
    await openPage(waiting);
    const yes = button(document.querySelector(".run")!, "Yes");
    // The agent asks again with the same options; the next read shows it.
    waiting.runs = [
      run({
        screen: "Run git push --force?\n❯ 1. Yes\n  2. No",
        questionId: "question-b-0000000002",
      }),
    ];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.querySelector(".run pre")?.textContent).toContain("git push --force");
    expect(button(document.querySelector(".run")!, "Yes")).toBe(yes);
    yes.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)!.body).toMatchObject({ label: "Yes", questionId: "question-b-0000000002" });
  });

  it("keeps the runs it can answer when what it's told of hosts can't be read", async () => {
    await openPage({ runs: [run({ hostId: "local", host: "greg-studio" })], hosts: [null, 7] });
    expect(document.querySelectorAll(".run")).toHaveLength(1);
    expect(document.getElementById("status")!.textContent).toBe("");
  });

  const emptyText = () => {
    const empty = document.getElementById("empty")!;
    return empty.hidden ? null : document.getElementById("empty-covered")!.textContent;
  };

  it("names every machine it read when nothing is waiting", async () => {
    await openPage({
      runs: [],
      hosts: [{ hostId: "studio-03", host: "Studio", status: "ok" }],
    });
    expect(emptyText()).toBe("No agent is waiting on this computer or Studio.");
    expect(document.getElementById("hosts")!.textContent).toBe("");
  });

  it("names this computer when it's told of no hosts, as an older Daintree sends it", async () => {
    await openPage({ runs: [] });
    expect(emptyText()).toBe("No agent is waiting on this computer.");
  });

  it("names this computer by the name the list gives it", async () => {
    await openPage({ computer: "Greg's MacBook Pro", runs: [], hosts: [] });
    expect(emptyText()).toBe("No agent is waiting on Greg's MacBook Pro.");
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
    expect(document.querySelector(".run .where")!.textContent).toBe("greg-studio · Claude");
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

  it("says since when Daintree stopped answering and stops offering the cards it last read", async () => {
    vi.setSystemTime(new Date(2026, 9, 23, 9, 4, 58));
    await openPage({ runs: [run({}), run({ runId: "run-2" })], hosts: [] });
    expect(answerButtons()).toHaveLength(4);
    expect(answerButtons().every((b) => !b.disabled)).toBe(true);

    waitingReply = "unreachable";
    await vi.advanceTimersByTimeAsync(3000);
    const downAt = Date.now();
    expect(status()).toBe("Couldn't reach Daintree since " + hhmm(downAt) + " (0 min).");
    // The cards stay to read, but none can be answered from a list that may be old.
    expect(document.querySelectorAll(".run")).toHaveLength(2);
    expect(answerButtons().every((b) => b.disabled)).toBe(true);
    answerButtons()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.some((s) => s.path === "/api/answer")).toBe(false);

    // Later failures keep the first one's time and count on from it.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(hhmm(Date.now())).not.toBe(hhmm(downAt));
    expect(status()).toContain("since " + hhmm(downAt) + " (3 min)");
    expect(answerButtons().every((b) => b.disabled)).toBe(true);

    waitingReply = "ok";
    await vi.advanceTimersByTimeAsync(3000);
    expect(status()).toBe("");
    expect(answerButtons()).toHaveLength(4);
    expect(answerButtons().every((b) => !b.disabled)).toBe(true);

    // A fresh outage is timed from its own start, not the last one's.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    waitingReply = "unreachable";
    await vi.advanceTimersByTimeAsync(3000);
    expect(status()).toContain("since " + hhmm(Date.now()));
  });

  it("stops offering the other cards when a read in flight during an answer fails", async () => {
    await openPage({ runs: [run({}), run({ runId: "run-2" })], hosts: [] });
    waitingReply = "pending";
    await vi.advanceTimersByTimeAsync(3000);
    const [first, second] = [...document.querySelectorAll(".run")];
    const receipt = "Answered “Yes” · " + hhmm(Date.now());
    button(first!, "Yes").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(first!.querySelector(".result")!.textContent).toBe(receipt);

    settlePending("unreachable");
    await vi.advanceTimersByTimeAsync(0);
    expect(status()).toContain("Couldn't reach Daintree since");
    expect([...second!.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    expect(first!.querySelector(".result")!.textContent).toBe(receipt);
  });

  it("shows nothing from a read that comes back after unpairing", async () => {
    await openPage({ runs: [run({})], hosts: [] });
    waitingReply = "pending";
    await vi.advanceTimersByTimeAsync(3000);
    document.getElementById("forget")!.click();
    // Unpairing is confirmed first; nothing is removed by the first tap.
    expect(document.querySelectorAll(".run")).toHaveLength(1);
    document.getElementById("unpair-confirm")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toMatchObject({ method: "POST", path: "/api/unpair" });
    expect(document.querySelectorAll(".run")).toHaveLength(0);

    settlePending("ok");
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll(".run")).toHaveLength(0);
  });

  it("stops offering the cards when Daintree answers but can't give the list", async () => {
    await openPage({ runs: [run({})], hosts: [] });
    waitingReply = "error";
    await vi.advanceTimersByTimeAsync(3000);
    expect(status()).toBe("Daintree is busy.");
    expect(answerButtons().every((b) => b.disabled)).toBe(true);
  });

  it("goes back to pairing on a 401 rather than saying Daintree is unreachable", async () => {
    await openPage({ runs: [run({})], hosts: [] });
    waitingReply = "unreachable";
    await vi.advanceTimersByTimeAsync(3000);
    expect(status()).toContain("since");
    waitingReply = 401;
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.getElementById("pair")!.hidden).toBe(false);
    expect(document.getElementById("main")!.hidden).toBe(true);
    expect(localStorage.getItem("daintree-device-token")).toBeNull();
    // Nothing more is asked for until it's paired again.
    const asked = sent.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(asked);
  });

  it("says since when a host that was read stopped answering, and drops it once it answers", async () => {
    vi.setSystemTime(new Date(2026, 9, 23, 9, 4, 58));
    const mini = { hostId: "mini", host: "Mini", status: "ok" };
    await openPage({ runs: [], hosts: [mini] });
    const notes = () => document.getElementById("hosts")!.textContent;
    expect(notes()).toBe("");

    mini.status = "unreachable";
    await vi.advanceTimersByTimeAsync(3000);
    const downAt = Date.now();
    expect(notes()).toBe("Couldn't read the waiting agents on Mini since " + hhmm(downAt) + ".");

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(notes()).toBe("Couldn't read the waiting agents on Mini since " + hhmm(downAt) + ".");

    mini.status = "ok";
    await vi.advanceTimersByTimeAsync(3000);
    expect(notes()).toBe("");
  });

  it("says since when a host that was read stopped being connected", async () => {
    vi.setSystemTime(new Date(2026, 9, 23, 9, 4, 58));
    const mini = { hostId: "mini", host: "Mini", status: "ok" };
    await openPage({ runs: [], hosts: [mini] });

    mini.status = "not-connected";
    await vi.advanceTimersByTimeAsync(3000);
    const downAt = Date.now();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(document.getElementById("hosts")!.textContent).toBe(
      "Not connected to Mini since " + hhmm(downAt) + ", so its agents aren't shown."
    );
  });

  it("never says nothing is waiting when the host list couldn't be read, and says since when", async () => {
    vi.setSystemTime(new Date(2026, 9, 23, 9, 4, 58));
    const waiting: Record<string, unknown> = { runs: [], hosts: [], hostsUnlisted: true };
    await openPage(waiting);
    const downAt = Date.now();
    const notes = () => document.getElementById("hosts")!.textContent;
    const note =
      "Couldn't list the connected hosts since " + hhmm(downAt) + ", so their agents aren't shown.";
    expect(emptyText()).toBe("No agent is waiting on this computer.");
    expect(notes()).toBe(note);

    // The first failure's time holds for as long as the list stays unreadable.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(notes()).toBe(note);

    waiting.hostsUnlisted = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(notes()).toBe("");
    expect(emptyText()).toBe("No agent is waiting on this computer.");
  });

  it("gives no time for a host that was never read, since it can't know when it went", async () => {
    await openPage({ runs: [], hosts: [{ hostId: "mini", host: "Mini", status: "unreachable" }] });
    expect(document.getElementById("hosts")!.textContent).toBe(
      "Couldn't read the waiting agents on Mini."
    );
  });

  /** A run as listed past the cap: no screen, no options, no question. */
  const unreadRun = (overrides: Record<string, unknown>) => {
    const { screen: _screen, choices: _choices, questionId: _questionId, ...rest } = run(overrides);
    return rest;
  };
  const here = { hostId: "local", host: "greg-studio" };
  /** Three runs waiting on this computer, the third left unread by the cap. */
  const capped = () => ({
    computer: "greg-studio",
    runs: [run(here), run({ ...here, runId: "run-2", project: "api" })],
    omitted: [unreadRun({ ...here, runId: "run-3", project: "docs", waitingReason: "prompt" })],
    coverage: [{ ...here, listed: 2, waiting: 3 }],
    hosts: [],
  });
  const CUT = "Showing 2 of 3 waiting agents on greg-studio. Pick one under Others waiting to read its screen.";
  const live = () => document.getElementById("announce")!.textContent;
  const count = () => document.getElementById("count")!.textContent;
  const notes = () => document.getElementById("hosts")!;

  it("says how many of a machine's waiting agents it shows, counts them all, and tells a screen reader", async () => {
    await openPage(capped());
    await vi.advanceTimersByTimeAsync(60);
    expect(notes().hidden).toBe(false);
    expect(notes().textContent).toBe(CUT);
    expect(count()).toBe("3");
    expect(live()).toBe(CUT);
    expect(emptyText()).toBeNull();
    const more = document.getElementById("more")!;
    expect(more.hidden).toBe(false);
    expect(more.querySelector(".other .project")!.textContent).toBe("docs");
    expect(more.querySelector(".other .meta")!.textContent).toBe("Waiting for input");

    // The same cut read again isn't said again; a different one is.
    document.getElementById("announce")!.textContent = "";
    await vi.advanceTimersByTimeAsync(3000 + 60);
    expect(live()).toBe("");
  });

  it("says it again when the cut changes", async () => {
    const waiting = capped();
    await openPage(waiting);
    waiting.coverage = [{ ...here, listed: 2, waiting: 4 }];
    await vi.advanceTimersByTimeAsync(3000 + 60);
    expect(live()).toBe(
      "Showing 2 of 4 waiting agents on greg-studio. Pick one under Others waiting to read its screen. 1 more isn't listed."
    );
    expect(count()).toBe("4");
  });

  it("never says it's up to date over a list that was cut", async () => {
    await openPage(capped());
    waitingReply = "pending";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(500);
    expect(live()).toContain("Checking for changes");
    settlePending("ok");
    await vi.advanceTimersByTimeAsync(60);
    expect(live()).toBe("Up to date. " + CUT);
  });

  it("reads the run picked from the others on every read, moving focus to its card, until it stops waiting", async () => {
    const waiting = capped();
    await openPage(waiting);
    const show = document.querySelector<HTMLButtonElement>("#others button")!;
    expect(show.textContent).toBe("Show its screen");
    show.focus();
    // Read first, the picked run takes the slot of the least pressing one.
    waiting.runs = [run(here), run({ ...here, runId: "run-3", project: "docs" })];
    waiting.omitted = [unreadRun({ ...here, runId: "run-2", project: "api" })];
    show.click();
    expect(show.textContent).toBe("Reading its screen…");
    expect(show.getAttribute("aria-disabled")).toBe("true");
    await vi.advanceTimersByTimeAsync(0);
    const asked = sent.at(-1)!.path;
    expect(asked.startsWith("/api/waiting?hosts=1&read=")).toBe(true);
    expect(JSON.parse(decodeURIComponent(asked.split("read=")[1]!))).toEqual({
      hostId: "local",
      runId: "run-3",
      spawnedAt: 100,
    });
    const card = [...document.querySelectorAll(".run")].find(
      (candidate) => candidate.querySelector(".project")!.textContent === "docs"
    )!;
    expect(card.querySelector("pre")!.textContent).toContain("Yes");
    expect(document.activeElement).toBe(card.querySelector(".project"));
    expect(document.querySelector("#others .project")!.textContent).toBe("api");

    await vi.advanceTimersByTimeAsync(3000);
    expect(sent.at(-1)!.path).toBe(asked);

    // Listed nowhere once it stops waiting, so the next read asks for it no more.
    waiting.runs = [run(here)];
    waiting.omitted = [unreadRun({ ...here, runId: "run-2", project: "api" })];
    waiting.coverage = [{ ...here, listed: 1, waiting: 2 }];
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent.at(-1)!.path).toBe("/api/waiting?hosts=1");
  });

  it("never says a run pushed past the cap stopped waiting", async () => {
    const waiting = capped();
    await openPage(waiting, async () => {
      throw new TypeError("Failed to fetch");
    });
    const second = [...document.querySelectorAll(".run")][1]!;
    waiting.runs = [run(here), run({ ...here, runId: "run-3", project: "docs" })];
    waiting.omitted = [unreadRun({ ...here, runId: "run-2", project: "api" })];
    button(second, "Yes").click();
    await vi.advanceTimersByTimeAsync(1000);
    const result = second.querySelector(".result")!.textContent;
    expect(result).toContain("It's still waiting, listed under Others waiting without its screen.");
    expect(result).not.toContain("isn't listed as waiting");
  });

  it("never calls a host that can't say how many wait there complete", async () => {
    const old = { hostId: "old", host: "Old" };
    const waiting = {
      computer: "greg-studio",
      runs: [run(here)],
      omitted: [],
      coverage: [
        { ...here, listed: 1, waiting: 1 },
        { ...old, listed: 0, waiting: null },
      ],
      hosts: [{ ...old, status: "ok" }],
    };
    await openPage(waiting);
    expect(notes().textContent).toBe(
      "Old runs an older Daintree that doesn't say whether more agents are waiting there than are shown. Update it there to see them all."
    );
    expect(count()).toBe("1+");

    waiting.runs = [];
    waiting.coverage = [
      { ...here, listed: 0, waiting: 0 },
      { ...old, listed: 0, waiting: null },
    ];
    await vi.advanceTimersByTimeAsync(3000);
    expect(emptyText()).toBe("No agent is waiting on greg-studio.");
  });
});
