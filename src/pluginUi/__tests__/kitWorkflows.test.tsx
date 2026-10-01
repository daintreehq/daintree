// @vitest-environment jsdom
import { createElement, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";

beforeAll(async () => {
  await primeRadix();
  render(createElement(kit.Spinner));
  await vi.waitFor(
    () => {
      if (!document.querySelector(".animate-spin")) throw new Error("kit not loaded");
    },
    { timeout: 5_000 }
  );
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const withTooltips = (child: ReactNode) => createElement(TooltipProvider, null, child);

describe("AttachmentList", () => {
  const files = [
    { id: "a", name: "spec.pdf", detail: "1.2 MB" },
    { id: "b", name: "logo.png", status: "pending" as const },
    { id: "c", name: "notes.md", status: "failed" as const, detail: "Too large" },
  ];

  it("opens ready items, never pending ones, and moves focus on removal", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(createElement(kit.AttachmentList, { attachments: files, onOpen, onRemove }));
    fireEvent.click(screen.getByRole("button", { name: "spec.pdf" }));
    expect(onOpen).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("button", { name: "logo.png" })).toBeNull();
    const removeFirst = screen.getByRole("button", { name: "Remove spec.pdf" });
    removeFirst.focus();
    fireEvent.click(removeFirst);
    expect(onRemove).toHaveBeenCalledWith("a");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove logo.png" }));
  });

  it("draws rows with their detail and a failure's cause", () => {
    render(createElement(kit.AttachmentList, { attachments: files, layout: "rows" }));
    const list = screen.getByRole("list", { name: "Attachments" });
    expect(within(list).getByText("Too large")).toBeTruthy();
    expect(within(list).getByText("Uploading")).toBeTruthy();
  });

  it("draws the empty state, or nothing", () => {
    const { container, rerender } = render(createElement(kit.AttachmentList, { attachments: [] }));
    expect(container.textContent).toBe("");
    rerender(createElement(kit.AttachmentList, { attachments: [], empty: "No files yet" }));
    expect(screen.getByText("No files yet")).toBeTruthy();
  });
});

describe("EntityChip", () => {
  it("opens an available record and names its kind", () => {
    const onOpen = vi.fn();
    render(createElement(kit.EntityChip, { label: "Acme Corp", type: "Customer", onOpen }));
    fireEvent.click(screen.getByRole("button", { name: "Customer, Acme Corp" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable reference, says why, and does not open it", () => {
    const onOpen = vi.fn();
    render(createElement(kit.EntityChip, { label: "Old deal", availability: "missing", onOpen }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "Old deal, Deleted" })).toBeTruthy();
  });
});

interface Line {
  id: string;
  name: string;
}

describe("RepeaterField", () => {
  function Lines({
    initial,
    errors,
    min,
    max,
    disabled,
  }: {
    initial: Line[];
    errors?: Record<string, string>;
    min?: number;
    max?: number;
    disabled?: boolean;
  }) {
    const [items, setItems] = useState(initial);
    const next = useRef(100);
    return createElement(kit.RepeaterField<Line>, {
      items,
      "aria-label": "Line items",
      getKey: (item) => item.id,
      getItemLabel: (item) => item.name || "New line",
      onChange: setItems,
      createItem: () => ({ id: `n${next.current++}`, name: "" }),
      duplicateItem: (item) => ({ id: `${item.id}-copy`, name: item.name }),
      errors,
      min,
      max,
      disabled,
      renderItem: (item, { update }) =>
        createElement("input", {
          "aria-label": `${item.id} name`,
          value: item.name,
          onChange: (event: { target: { value: string } }) =>
            update({ ...item, name: event.target.value }),
        }),
    });
  }

  it("adds items with fresh keys and focuses each new field", () => {
    render(createElement(Lines, { initial: [{ id: "a", name: "Desk" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "n100 name" }));
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "n101 name" }));
  });

  it("keeps an error on its item after an item above it goes", () => {
    render(
      createElement(Lines, {
        initial: [
          { id: "a", name: "Desk" },
          { id: "b", name: "Chair" },
        ],
        errors: { b: "Price is required" },
      })
    );
    const remove = screen.getByRole("button", { name: "Remove Desk" });
    remove.focus();
    fireEvent.click(remove);
    const chair = document.querySelector("[data-repeater-item='b']")!;
    expect(chair.textContent).toContain("Price is required");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Chair" }));
  });

  it("duplicates under the item and holds to min and max", () => {
    render(createElement(Lines, { initial: [{ id: "a", name: "Desk" }], min: 1, max: 2 }));
    expect(
      (screen.getByRole("button", { name: "Remove Desk" }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Desk" }));
    const keys = [...document.querySelectorAll("[data-repeater-item]")].map((el) =>
      el.getAttribute("data-repeater-item")
    );
    expect(keys).toEqual(["a", "a-copy"]);
    expect((screen.getByRole("button", { name: "Add item" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});

describe("FormErrorSummary", () => {
  it("lists form errors first and focuses a field after onSelect", async () => {
    const onSelect = vi.fn();
    render(
      createElement(
        "div",
        null,
        createElement(kit.FormErrorSummary, {
          errors: [
            { field: "email", message: "Enter an email address" },
            { message: "The server refused the request" },
          ],
          onSelect,
        }),
        createElement("input", { id: "email", "aria-label": "Email" })
      )
    );
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["The server refused the request", "Enter an email address"]);
    fireEvent.click(screen.getByRole("button", { name: "Enter an email address" }));
    expect(onSelect).toHaveBeenCalledWith("email");
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Email" }));
  });

  it("renders nothing without errors", () => {
    const { container } = render(createElement(kit.FormErrorSummary, { errors: [] }));
    expect(container.textContent).toBe("");
  });
});

describe("UnsavedChangesBar", () => {
  it("holds Save while a save is out and keeps the edits on a rejection", async () => {
    let reject: (error: Error) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })
    );
    render(createElement(kit.UnsavedChangesBar, { changes: 3, onSave, onDiscard: () => {} }));
    expect(screen.getByText("3 unsaved changes")).toBeTruthy();
    const save = screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement;
    fireEvent.click(save);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    reject(new Error("Disk full"));
    await tick();
    expect(screen.getByRole("alert").textContent).toContain("Disk full");
    expect(screen.getByText("3 unsaved changes")).toBeTruthy();
  });

  it("is gone with nothing to save", () => {
    const { container } = render(
      createElement(kit.UnsavedChangesBar, { changes: 0, onSave: () => {}, onDiscard: () => {} })
    );
    expect(container.textContent).toBe("");
  });
});

describe("OperationStatus and ConnectionCard", () => {
  it("words every state, and the compact form keeps the word for assistive tech", () => {
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.OperationStatus, { state: "awaiting-approval" }),
          createElement(kit.OperationStatus, { state: "unknown", compact: true })
        )
      )
    );
    expect(screen.getByText("Awaiting approval")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Outcome unknown" })).toBeTruthy();
  });

  it("says what a connection is and shows its actions", () => {
    render(
      createElement(kit.ConnectionCard, {
        name: "Linear",
        account: "acme.linear.app",
        status: "expired",
        detail: "Sign in again to keep syncing",
        actions: createElement("button", { type: "button" }, "Reconnect"),
      })
    );
    const card = screen.getByRole("region", { name: "Linear" });
    expect(card.textContent).toContain("Sign-in expired");
    expect(within(card).getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});

describe("ToolCallCard", () => {
  it("opens on its input and result", () => {
    render(
      createElement(kit.ToolCallCard, {
        name: "search_issues",
        summary: "Find open bugs",
        state: "done",
        input: { query: "is:open" },
        result: "3 issues",
        startedAt: 1_000,
        finishedAt: 1_450,
      })
    );
    const row = screen.getByRole("button", { name: /search_issues/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain("450ms");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("3 issues")).toBeTruthy();
  });
});

describe("StructuredDiff", () => {
  const changes = [
    { id: "status", label: "Status", before: "Lead", after: "Customer" },
    { id: "phone", label: "Phone", kind: "added" as const, after: "555-0100" },
    { id: "owner", label: "Owner", before: "Ada", after: "Nobody", error: "No such user" },
  ];

  it("selects only valid changes, one by one or all at once", () => {
    const onSelectedChange = vi.fn();
    render(createElement(kit.StructuredDiff, { changes, selected: ["status"], onSelectedChange }));
    expect(screen.getByText("1 of 2 selected")).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Apply Owner" }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply Phone" }));
    expect(onSelectedChange).toHaveBeenLastCalledWith(["status", "phone"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all changes" }));
    expect(onSelectedChange).toHaveBeenLastCalledWith(["status", "phone"]);
  });

  it("reads as a table of field, before and after", () => {
    render(createElement(kit.StructuredDiff, { changes }));
    const status = screen.getByRole("row", { name: /Status/ });
    expect(within(status).getByText("Lead")).toBeTruthy();
    expect(within(status).getByText("Customer")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("SuggestedValue", () => {
  it("accepts and rejects, and refuses to accept a stale one", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const { rerender } = render(
      createElement(kit.SuggestedValue, {
        label: "Industry",
        current: "Unknown",
        suggested: "Logistics",
        onAccept,
        onReject,
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    rerender(
      createElement(kit.SuggestedValue, {
        label: "Industry",
        suggested: "Logistics",
        onAccept,
        onReject,
        stale: true,
      })
    );
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

describe("Sources", () => {
  it("numbers citations and lists sources in order", () => {
    const onOpen = vi.fn();
    render(
      withTooltips(
        createElement(
          "div",
          null,
          createElement(kit.SourceCitation, {
            index: 2,
            title: "Pricing page",
            locator: "p. 3",
            onOpen,
          }),
          createElement(kit.SourceList, {
            sources: [
              { id: "s1", title: "Contract", excerpt: "Renews yearly" },
              { id: "s2", title: "Pricing page", locator: "p. 3" },
            ],
            onOpen,
          })
        )
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Source 2: Pricing page, p. 3" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const list = screen.getByRole("list", { name: "Sources" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(list).getByRole("button", { name: "Contract" }));
    expect(onOpen).toHaveBeenLastCalledWith("s1");
  });
});

describe("DecisionRequest", () => {
  const choices = [
    { id: "merge", label: "Merge" },
    { id: "skip", label: "Skip", variant: "secondary" as const },
  ];

  it("takes one answer at a time while a response is out", async () => {
    let resolve: () => void = () => {};
    const onRespond = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    render(createElement(kit.DecisionRequest, { title: "Merge 3 contacts?", choices, onRespond }));
    fireEvent.click(screen.getByRole("button", { name: /Merge/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("merge");
    resolve();
    await tick();
  });

  it("shows the answer once answered, and why it can't be answered otherwise", () => {
    const { rerender } = render(
      createElement(kit.DecisionRequest, {
        title: "Merge 3 contacts?",
        choices,
        onRespond: () => {},
        status: "answered",
        answer: "skip",
      })
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Answered: Skip")).toBeTruthy();
    rerender(
      createElement(kit.DecisionRequest, {
        title: "Merge 3 contacts?",
        choices,
        onRespond: () => {},
        status: "superseded",
      })
    );
    expect(screen.getByText("Replaced by a newer request")).toBeTruthy();
  });
});

describe("review regressions", () => {
  it("RepeaterField: disabled stops an item's own edits", () => {
    function Probe() {
      const [items, setItems] = useState([{ id: "a", name: "Desk" }]);
      return createElement(kit.RepeaterField<Line>, {
        items,
        "aria-label": "Lines",
        getKey: (item) => item.id,
        onChange: setItems,
        disabled: true,
        renderItem: (item, { update, disabled }) =>
          createElement("button", {
            type: "button",
            "data-disabled": String(disabled),
            onClick: () => update({ ...item, name: "Changed" }),
            children: item.name,
          }),
      });
    }
    render(createElement(Probe));
    const field = screen.getByRole("button", { name: "Desk" });
    expect(field.getAttribute("data-disabled")).toBe("true");
    fireEvent.click(field);
    expect(screen.getByRole("button", { name: "Desk" })).toBeTruthy();
  });

  it("RepeaterField: a Remove held at min hands focus to the remaining field", () => {
    function Probe() {
      const [items, setItems] = useState([
        { id: "a", name: "Desk" },
        { id: "b", name: "Chair" },
      ]);
      return createElement(kit.RepeaterField<Line>, {
        items,
        "aria-label": "Lines",
        getKey: (item) => item.id,
        getItemLabel: (item) => item.name,
        onChange: setItems,
        min: 1,
        renderItem: (item) => createElement("input", { "aria-label": `${item.id} name` }),
      });
    }
    render(createElement(Probe));
    const remove = screen.getByRole("button", { name: "Remove Desk" });
    remove.focus();
    fireEvent.click(remove);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "b name" }));
  });

  it("RepeaterField: repaired keys never collide", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      createElement(kit.RepeaterField<{ k: string }>, {
        items: [{ k: "x#2" }, { k: "x" }, { k: "x" }],
        "aria-label": "Keys",
        getKey: (item) => item.k,
        onChange: () => {},
        renderItem: (item) => item.k,
      })
    );
    const keys = [...document.querySelectorAll("[data-repeater-item]")].map((el) =>
      el.getAttribute("data-repeater-item")
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("AttachmentList: removing the last one keeps focus in the list", () => {
    function Probe() {
      const [files, setFiles] = useState([{ id: "a", name: "spec.pdf" }]);
      return createElement(kit.AttachmentList, {
        attachments: files,
        onRemove: (id: string) => setFiles((all) => all.filter((file) => file.id !== id)),
        "data-testid": "files",
      });
    }
    render(createElement(Probe));
    const remove = screen.getByRole("button", { name: "Remove spec.pdf" });
    remove.focus();
    fireEvent.click(remove);
    expect(document.activeElement).toBe(screen.getByTestId("files"));
  });

  it("UnsavedChangesBar: a save that lands frees the bar; a discard clears a failure", async () => {
    let settle: { resolve(): void; reject(error: Error): void } = {
      resolve: () => {},
      reject: () => {},
    };
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        })
    );
    const onDiscard = vi.fn();
    render(createElement(kit.UnsavedChangesBar, { changes: 2, onSave, onDiscard }));
    const save = () => screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement;
    const discard = () => screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement;
    fireEvent.click(save());
    expect(discard().disabled).toBe(true);
    settle.resolve();
    await tick();
    expect(discard().disabled).toBe(false);
    fireEvent.click(save());
    settle.reject(new Error("Disk full"));
    await tick();
    expect(screen.getByRole("alert").textContent).toContain("Disk full");
    fireEvent.click(discard());
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("DecisionRequest: recovers after an answer settles, says why one failed, and a new status drops the failure", async () => {
    let settle: { resolve(): void; reject(error: Error): void } = {
      resolve: () => {},
      reject: () => {},
    };
    const onRespond = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        })
    );
    const choices = [{ id: "go", label: "Go", variant: "default" as const }];
    const { rerender } = render(
      createElement(kit.DecisionRequest, { title: "Proceed?", choices, onRespond })
    );
    const go = () => screen.getByRole("button", { name: /Go/ }) as HTMLButtonElement;
    fireEvent.click(go());
    settle.resolve();
    await tick();
    fireEvent.click(go());
    expect(onRespond).toHaveBeenCalledTimes(2);
    settle.reject(new Error("Run is gone"));
    await tick();
    expect(screen.getByRole("alert").textContent).toContain("Run is gone");
    rerender(
      createElement(kit.DecisionRequest, {
        title: "Proceed?",
        choices,
        onRespond,
        status: "expired",
      })
    );
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Expired");
  });

  it("SourceList numbers sources in order", () => {
    render(
      createElement(kit.SourceList, {
        sources: [
          { id: "b", title: "Second" },
          { id: "a", title: "First" },
        ],
      })
    );
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual(["1Second", "2First"]);
  });

  it("a callback that throws or rejects is contained", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      createElement(kit.SuggestedValue, {
        suggested: "x",
        onAccept: () => {
          throw new Error("accept broke");
        },
        onReject: () => Promise.reject(new Error("reject broke")),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await tick();
    const lines = logged.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("SuggestedValue onAccept threw"))).toBe(true);
    expect(lines.some((line) => line.includes("SuggestedValue onReject rejected"))).toBe(true);
  });

  it("a timestamp past what a Date holds is no timestamp", () => {
    render(
      createElement(kit.ConnectionCard, { name: "Linear", status: "connected", checkedAt: 1e20 })
    );
    expect(screen.getByRole("region", { name: "Linear" }).textContent).not.toContain("Checked");
  });
});
