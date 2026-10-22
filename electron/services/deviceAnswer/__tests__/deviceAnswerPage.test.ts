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
      const data = path === "/api/waiting" ? waiting : await answer();
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
