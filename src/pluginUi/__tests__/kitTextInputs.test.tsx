// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import type { KeyValuePair, MentionSuggestion } from "@daintreehq/plugin-ui";
import {
  findMentionSession,
  insertMention,
  keyValueErrors,
  listErrors,
  parseAssignments,
} from "@/components/PluginKit/PluginKitTextInputs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keybindingService } from "@/services/KeybindingService";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const PEOPLE: MentionSuggestion[] = [
  { id: "alice", label: "alice", description: "Alice Chen" },
  { id: "bob", label: "bob", description: "Bob Ortiz", disabled: true },
  { id: "carol", label: "carol", description: "Carol Diaz", badge: "Team" },
];

function type(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector("textarea");
  if (!el) throw new Error("no textarea");
  return el;
}

describe("mention parsing", () => {
  const triggers = [
    { char: "@", atStart: false },
    { char: "/", atStart: true },
  ];

  it("finds a trigger at the start or after whitespace, with its query", () => {
    expect(findMentionSession("@al", 3, triggers)).toEqual({ char: "@", start: 0, query: "al" });
    expect(findMentionSession("hi @bo", 6, triggers)).toEqual({
      char: "@",
      start: 3,
      query: "bo",
    });
    expect(findMentionSession("hi @", 4, triggers)).toEqual({ char: "@", start: 3, query: "" });
  });

  it("ignores a trigger inside a word, past whitespace, or off the start when atStart", () => {
    expect(findMentionSession("a@b.c", 5, triggers)).toBeNull();
    expect(findMentionSession("@al ice", 7, triggers)).toBeNull();
    expect(findMentionSession("run /test", 9, triggers)).toBeNull();
    expect(findMentionSession("/test", 5, triggers)).toEqual({
      char: "/",
      start: 0,
      query: "test",
    });
  });

  it("reads the nearest boundary trigger when another sits inside the query", () => {
    expect(findMentionSession("@src/lib", 8, triggers)).toEqual({
      char: "@",
      start: 0,
      query: "src/lib",
    });
  });

  it("replaces the trigger and query and puts the caret after one space", () => {
    const session = { char: "@", start: 3, query: "al" };
    expect(insertMention("hi @al", session, { label: "alice" })).toEqual({
      text: "hi @alice ",
      caret: 10,
    });
    expect(insertMention("hi @al rest", session, { label: "alice" })).toEqual({
      text: "hi @alice rest",
      caret: 10,
    });
    expect(
      insertMention(
        "@",
        { char: "@", start: 0, query: "" },
        {
          label: "x",
          insertText: "[[x]]",
        }
      )
    ).toEqual({ text: "[[x]] ", caret: 6 });
  });
});

describe("MentionTextarea", () => {
  function Mentions(props: { getSuggestions?: kit.MentionTextareaProps["getSuggestions"] }) {
    const [value, setValue] = useState("");
    return (
      <>
        <kit.MentionTextarea
          aria-label="Message"
          value={value}
          onValueChange={setValue}
          triggers={[
            { char: "@", title: "People", emptyMessage: "No people match" },
            "#",
            7 as never,
          ]}
          getSuggestions={
            props.getSuggestions ??
            ((_trigger, query) => PEOPLE.filter((person) => person.label.startsWith(query)))
          }
        />
        <output data-testid="value">{value}</output>
      </>
    );
  }

  it("opens the host menu on a trigger and inserts the selected row", () => {
    render(<Mentions />);
    const field = screen.getByRole("textbox", { name: "Message" });
    type(field, "ask @");
    const list = screen.getByRole("listbox", { name: "People" });
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(field.getAttribute("aria-controls")).toBeTruthy();
    expect(field.getAttribute("aria-activedescendant")).toMatch(/-option-0$/);
    // Down skips the disabled row.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toMatch(/-option-2$/);
    expect(screen.getByText("Team")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("ask @carol ");
    expect(field.getAttribute("aria-controls")).toBeNull();
  });

  it("puts the caret after the inserted token", () => {
    render(<Mentions />);
    const field = textarea();
    type(field, "@al");
    fireEvent.keyDown(field, { key: "Tab" });
    expect(field.value).toBe("@alice ");
    expect(field.selectionStart).toBe(7);
  });

  it("never inserts a disabled row, by click or key", () => {
    render(<Mentions />);
    const field = textarea();
    type(field, "@b");
    const row = screen.getByRole("option", { name: /bob/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("@b");
  });

  it("closes on Escape without the key reaching the pane, and stays shut for that trigger", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Mentions />
      </div>
    );
    const field = textarea();
    type(field, "@a");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    expect(field.getAttribute("aria-controls")).toBeNull();
    type(field, "@al");
    expect(field.getAttribute("aria-controls")).toBeNull();
    type(field, "@al @");
    expect(field.getAttribute("aria-controls")).toBeTruthy();
  });

  it("drops the menu when the parent replaces the text under it", () => {
    function Resettable() {
      const [value, setValue] = useState("");
      return (
        <>
          <kit.MentionTextarea
            aria-label="Message"
            value={value}
            onValueChange={setValue}
            triggers={["@"]}
            getSuggestions={() => PEOPLE}
          />
          <button type="button" onClick={() => setValue("hi!")}>
            Reset
          </button>
        </>
      );
    }
    render(<Resettable />);
    const field = textarea();
    type(field, "@al");
    expect(field.getAttribute("aria-controls")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(field.getAttribute("aria-controls")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("hi!");
  });

  it("says when nothing matches", () => {
    render(<Mentions />);
    type(textarea(), "@zz");
    expect(screen.getByText("No people match")).toBeTruthy();
  });

  it("drops an async reply that arrives after a newer query", async () => {
    const pending: ((rows: MentionSuggestion[]) => void)[] = [];
    render(
      <Mentions
        getSuggestions={() => new Promise<MentionSuggestion[]>((resolve) => pending.push(resolve))}
      />
    );
    const field = textarea();
    type(field, "@a");
    type(field, "@al");
    expect(screen.getByText("Searching…")).toBeTruthy();
    await act(async () => {
      pending[1]!([{ id: "new", label: "alice" }]);
      await Promise.resolve();
    });
    await act(async () => {
      pending[0]!([{ id: "old", label: "adam" }]);
      await Promise.resolve();
    });
    expect(screen.getByRole("option", { name: /alice/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /adam/ })).toBeNull();
  });

  it("ignores junk suggestions and a throwing source", () => {
    render(
      <Mentions
        getSuggestions={(_t, query) => {
          if (query === "x") throw new Error("boom");
          return [null, { id: "a" }, { id: "b", label: "bee" }, { id: "b", label: "dup" }] as never;
        }}
      />
    );
    const field = textarea();
    type(field, "@b");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    type(field, "@x");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("is a plain textarea without triggers", () => {
    render(<kit.MentionTextarea aria-label="Notes" defaultValue="hi" />);
    const field = screen.getByRole("textbox", { name: "Notes" });
    expect(field.getAttribute("aria-autocomplete")).toBeNull();
  });
});

describe("Composer", () => {
  function Harness(props: Partial<kit.ComposerProps>) {
    const [value, setValue] = useState(props.defaultValue ?? "");
    return <kit.Composer aria-label="Prompt" value={value} onValueChange={setValue} {...props} />;
  }

  it("sends on Cmd/Ctrl+Enter and makes a new line on Enter by default", () => {
    const onSubmit = vi.fn();
    render(<Harness defaultValue="fix the tests" onSubmit={onSubmit} />, {
      wrapper: TooltipProvider,
    });
    const field = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith("fix the tests");
  });

  it("sends on Enter when asked, keeping Shift+Enter for a new line", () => {
    const onSubmit = vi.fn();
    render(<Harness defaultValue="go" submitOn="enter" onSubmit={onSubmit} />, {
      wrapper: TooltipProvider,
    });
    const field = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("go");
  });

  it("holds Send while empty", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />, { wrapper: TooltipProvider });
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("turns Send into Stop while busy, and Escape stops", () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(<Harness defaultValue="more" busy onSubmit={onSubmit} onStop={onStop} />, {
      wrapper: TooltipProvider,
    });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("draws attachment chips that remove themselves, focusing the next", () => {
    const onRemoveAttachment = vi.fn();
    render(
      <Harness
        attachments={[
          { id: "a", name: "schema.json", detail: "4 KB" },
          { id: "b", name: "trace.log" },
          { id: "b", name: "duplicate" },
          { name: "no id" } as never,
        ]}
        onRemoveAttachment={onRemoveAttachment}
      />,
      { wrapper: TooltipProvider }
    );
    const list = screen.getByRole("list", { name: "Attachments" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("4 KB")).toBeTruthy();
    const first = screen.getByRole("button", { name: "Remove schema.json" });
    first.focus();
    fireEvent.click(first);
    expect(onRemoveAttachment).toHaveBeenCalledWith("a");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove trace.log" }));
  });

  it("takes pasted files when onAttach is set, filtered by accept", () => {
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} accept=".png" />, { wrapper: TooltipProvider });
    const png = new File(["x"], "shot.png", { type: "image/png" });
    const txt = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [png, txt] } });
    expect(onAttach).toHaveBeenCalledWith([png]);
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
  });

  it("counts characters once the draft passes 80% of the limit", () => {
    const { rerender } = render(<kit.Composer aria-label="Prompt" value="abc" maxLength={10} />, {
      wrapper: TooltipProvider,
    });
    expect(screen.queryByText("3 of 10 characters")).toBeNull();
    rerender(<kit.Composer aria-label="Prompt" value="abcdefghi" maxLength={10} />);
    expect(screen.getByText("9 of 10 characters")).toBeTruthy();
    const field = screen.getByRole("textbox");
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("renders its footer toolbar and mentions", () => {
    const onSubmit = vi.fn();
    render(
      <Harness
        toolbar={<span>Claude</span>}
        triggers={["/"]}
        getSuggestions={() => [{ id: "review", label: "review" }]}
        submitOn="enter"
        onSubmit={onSubmit}
      />,
      { wrapper: TooltipProvider }
    );
    expect(screen.getByText("Claude")).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Prompt" });
    type(field, "/");
    expect(screen.getByRole("option", { name: /review/ })).toBeTruthy();
    // Enter while the menu is up inserts rather than sending.
    fireEvent.keyDown(field, { key: "Enter" });
    expect((field as HTMLTextAreaElement).value).toBe("/review ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("holds Enter while suggestions are still loading, rather than sending the query", () => {
    const onSubmit = vi.fn();
    render(
      <Harness
        triggers={["@"]}
        getSuggestions={() => new Promise<MentionSuggestion[]>(() => {})}
        submitOn="enter"
        onSubmit={onSubmit}
      />,
      { wrapper: TooltipProvider }
    );
    const field = screen.getByRole("textbox", { name: "Prompt" });
    type(field, "@al");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("survives callbacks that throw", () => {
    const boom = () => {
      throw new Error("plugin bug");
    };
    render(<Harness defaultValue="hi" onSubmit={boom} onValueChange={boom} />, {
      wrapper: TooltipProvider,
    });
    const field = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(field, { target: { value: "hello" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});

describe("InlineEdit", () => {
  function Rename(props: Partial<kit.InlineEditProps>) {
    const [value, setValue] = useState("Create issue");
    return (
      <kit.InlineEdit
        aria-label="Request name"
        value={value}
        onCommit={(next) => setValue(next)}
        {...props}
      />
    );
  }

  it("starts on click, commits the trimmed value on Enter and refocuses the text", () => {
    const onCommit = vi.fn();
    render(<kit.InlineEdit aria-label="Request name" value="Old" onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button", { name: "Request name: Old" }));
    const input = screen.getByRole("textbox", { name: "Request name" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
    fireEvent.change(input, { target: { value: "  New name " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("New name");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement?.getAttribute("role")).toBe("button");
  });

  it("starts on F2, cancels on Escape without the key escaping", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Rename />
      </div>
    );
    const display = screen.getByRole("button");
    fireEvent.keyDown(display, { key: "F2" });
    outer.mockClear();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByRole("button").textContent).toBe("Create issue");
  });

  it("commits on blur, or cancels with blurAction", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<kit.InlineEdit aria-label="Name" value="a" onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "b" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onCommit).toHaveBeenCalledWith("b");
    rerender(
      <kit.InlineEdit aria-label="Name" value="a" onCommit={onCommit} blurAction="cancel" />
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "c" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("shows a validation message and stays open", () => {
    const onCommit = vi.fn();
    render(
      <kit.InlineEdit
        aria-label="Name"
        value="a"
        onCommit={onCommit}
        validate={(next) => (next.includes("/") ? "No slashes" : null)}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a/b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("No slashes")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Enter a name")).toBeTruthy();
  });

  it("refuses the value when the validator throws", () => {
    const onCommit = vi.fn();
    render(
      <kit.InlineEdit
        aria-label="Name"
        value="a"
        onCommit={onCommit}
        validate={() => {
          throw new Error("bug");
        }}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("ignores a commit that settles after its edit was closed from outside", async () => {
    let reject: (error: Error) => void = () => {};
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })
    );
    const { rerender } = render(
      <kit.InlineEdit aria-label="Name" value="a" onCommit={onCommit} editing />
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    rerender(<kit.InlineEdit aria-label="Name" value="a" onCommit={onCommit} editing={false} />);
    rerender(<kit.InlineEdit aria-label="Name" value="a" onCommit={onCommit} editing />);
    await act(async () => {
      reject(new Error("stale failure"));
      await Promise.resolve();
    });
    expect(screen.queryByText("stale failure")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false);
  });

  it("holds the field read-only while an async commit runs, and shows its failure", async () => {
    let reject: (error: Error) => void = () => {};
    const onCommit = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })
    );
    render(<kit.InlineEdit aria-label="Name" value="a" onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "taken" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      reject(new Error("That name is taken"));
      await Promise.resolve();
    });
    expect(input.readOnly).toBe(false);
    expect(screen.getByText("That name is taken")).toBeTruthy();
  });

  it("commits nothing for an unchanged value, and honours doubleClick activation", () => {
    const onCommit = vi.fn();
    render(
      <kit.InlineEdit aria-label="Name" value="same" onCommit={onCommit} activation="doubleClick" />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("KeyValueEditor", () => {
  it("parses env and header lines", () => {
    expect(parseAssignments("A=1\nexport B='two'\n# note\n\nContent-Type: text/plain")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two" },
      { key: "Content-Type", value: "text/plain" },
    ]);
    expect(parseAssignments("just text")).toBeNull();
  });

  it("flags empty and duplicate keys, case-insensitively when asked", () => {
    const rows = [
      { key: "Accept", value: "json" },
      { key: "accept", value: "xml" },
      { key: "", value: "orphan" },
      { key: "", value: "" },
    ];
    expect(keyValueErrors(rows, { caseInsensitive: true, allowDuplicates: false })).toEqual([
      "Duplicate key",
      "Duplicate key",
      "Enter a key",
      null,
    ]);
    expect(keyValueErrors(rows, { caseInsensitive: false, allowDuplicates: false })[0]).toBeNull();
  });

  function Editor(props: Partial<kit.KeyValueEditorProps>) {
    const [pairs, setPairs] = useState<KeyValuePair[]>([
      { id: "1", key: "Authorization", value: "Bearer x", secret: true },
      { id: "2", key: "Accept", value: "application/json" },
    ]);
    return (
      <>
        <kit.KeyValueEditor
          aria-label="Headers"
          value={pairs}
          onValueChange={setPairs}
          addLabel="Add header"
          {...props}
        />
        <output data-testid="pairs">{JSON.stringify(pairs)}</output>
      </>
    );
  }

  it("masks secret values and reports validity", () => {
    const onValidityChange = vi.fn();
    render(<Editor caseInsensitiveKeys onValidityChange={onValidityChange} />);
    const secret = screen.getByLabelText("Value of Authorization") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText("Key 2"), { target: { value: "authorization" } });
    expect(screen.getAllByText("Duplicate key")).toHaveLength(2);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("adds a row with focus in its key, and removes one", async () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    await flush();
    expect(document.activeElement).toBe(screen.getByLabelText("Key 3"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Accept" }));
    const pairs = JSON.parse(screen.getByTestId("pairs").textContent ?? "[]") as KeyValuePair[];
    expect(pairs.map((pair) => pair.key)).toEqual(["Authorization", ""]);
  });

  it("splits pasted KEY=value lines into rows", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.paste(screen.getByLabelText("Key 3"), {
      clipboardData: { getData: () => "X-Trace: on\nX-Env: dev" },
    });
    const pairs = JSON.parse(screen.getByTestId("pairs").textContent ?? "[]") as KeyValuePair[];
    expect(pairs.slice(2).map((pair) => [pair.key, pair.value])).toEqual([
      ["X-Trace", "on"],
      ["X-Env", "dev"],
    ]);
    expect(new Set(pairs.map((pair) => pair.id)).size).toBe(4);
  });

  it("survives a throwing onValidityChange", () => {
    render(
      <kit.KeyValueEditor
        aria-label="Env"
        defaultValue={[{ key: "A", value: "1" }]}
        onValidityChange={() => {
          throw new Error("bug");
        }}
      />
    );
    expect(screen.getByLabelText("Key 1")).toBeTruthy();
  });

  it("stops adding at max and ignores junk rows", () => {
    render(
      <kit.KeyValueEditor
        aria-label="Env"
        defaultValue={[{ key: "A", value: "1" }, null as never, { key: "B" } as never]}
        max={2}
      />
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ListEditor", () => {
  it("flags repeats and runs the validator on trimmed items", () => {
    expect(
      listErrors(["a", " a", "", "b!"], {
        allowDuplicates: false,
        validate: (item) => (item.endsWith("!") ? "No bangs" : null),
      })
    ).toEqual(["Already in the list", "Already in the list", null, "No bangs"]);
  });

  it("adds, pastes lines and removes", () => {
    const onValueChange = vi.fn();
    render(
      <kit.ListEditor
        aria-label="Hosts"
        defaultValue={["github.com"]}
        onValueChange={onValueChange}
        addLabel="Add host"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    fireEvent.paste(screen.getByLabelText("Hosts 2"), {
      clipboardData: { getData: () => "gitlab.com\n\nbitbucket.org" },
    });
    expect(onValueChange).toHaveBeenLastCalledWith(["github.com", "gitlab.com", "bitbucket.org"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove gitlab.com" }));
    expect(onValueChange).toHaveBeenLastCalledWith(["github.com", "bitbucket.org"]);
  });
});

describe("SecretInput", () => {
  it("masks the value, reveals it and blocks copying by default", () => {
    render(<kit.SecretInput aria-label="API token" defaultValue="ghp_123" />);
    const input = screen.getByLabelText("API token") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show value" }));
    expect(input.type).toBe("text");
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    input.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
  });

  it("allows copying when asked", () => {
    render(<kit.SecretInput aria-label="Key" defaultValue="k" allowCopy revealable={false} />);
    const input = screen.getByLabelText("Key");
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    input.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Show value" })).toBeNull();
  });

  it("shows a saved secret with Replace and Clear, and backs out of a replace", () => {
    const onReplace = vi.fn();
    const onClear = vi.fn();
    const onCancelReplace = vi.fn();
    render(
      <kit.SecretInput
        aria-label="GitHub token"
        stored
        storedHint="abcd1234"
        onReplace={onReplace}
        onClear={onClear}
        onCancelReplace={onCancelReplace}
      />
    );
    const group = screen.getByRole("group", { name: "GitHub token" });
    expect(group.textContent).toContain("Saved");
    expect(screen.getByText("ending in cd1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onReplace).toHaveBeenCalled();
    const input = screen.getByLabelText("GitHub token") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelReplace).toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "GitHub token" })).toBeTruthy();
  });

  it("hides a shown value when revealing is turned off", () => {
    const { rerender } = render(<kit.SecretInput aria-label="Key" defaultValue="k" />);
    fireEvent.click(screen.getByRole("button", { name: "Show value" }));
    expect((screen.getByLabelText("Key") as HTMLInputElement).type).toBe("text");
    rerender(<kit.SecretInput aria-label="Key" defaultValue="k" revealable={false} />);
    expect((screen.getByLabelText("Key") as HTMLInputElement).type).toBe("password");
  });

  it("keeps no draft behind the saved state, and hands focus back to Replace", () => {
    const { rerender } = render(<kit.SecretInput aria-label="Key" stored={false} />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "draft" } });
    rerender(<kit.SecretInput aria-label="Key" stored />);
    rerender(<kit.SecretInput aria-label="Key" stored={false} />);
    expect((screen.getByLabelText("Key") as HTMLInputElement).value).toBe("");
    rerender(<kit.SecretInput aria-label="Key" stored />);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.keyDown(screen.getByLabelText("Key"), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace" }));
  });

  it("submits on Enter", () => {
    const onSubmit = vi.fn();
    render(<kit.SecretInput aria-label="Key" defaultValue="s3cret" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByLabelText("Key"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("s3cret");
  });
});

describe("ShortcutRecorder", () => {
  function recorder(): HTMLElement {
    return screen.getByRole("button", { name: "Shortcut" });
  }

  it("records a combo on focus, holding the app's shortcuts back while it does", () => {
    const onValueChange = vi.fn();
    render(<kit.ShortcutRecorder onValueChange={onValueChange} />);
    const field = recorder();
    act(() => field.focus());
    expect(keybindingService.isCapturingShortcut()).toBe(true);
    fireEvent.keyDown(field, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(field.textContent).toContain("Now press a key");
    fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(onValueChange).toHaveBeenCalledWith("Cmd+Shift+K");
    expect(field.getAttribute("aria-pressed")).toBe("false");
    act(() => field.blur());
    expect(keybindingService.isCapturingShortcut()).toBe(false);
  });

  it("refuses a bare key, stops on Escape and clears on Backspace", () => {
    const onValueChange = vi.fn();
    render(<kit.ShortcutRecorder defaultValue="Cmd+J" onValueChange={onValueChange} />);
    const field = recorder();
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "j", code: "KeyJ" });
    expect(screen.getByRole("alert").textContent).toMatch(/Include Ctrl or Alt/);
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it("records a two-step chord, or finishes on the first step after the window", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    render(<kit.ShortcutRecorder allowChords onValueChange={onValueChange} />);
    const field = recorder();
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true });
    expect(field.textContent).toContain("Press second key");
    fireEvent.keyDown(field, { key: "s", code: "KeyS", ctrlKey: true });
    expect(onValueChange).toHaveBeenLastCalledWith("Cmd+K Cmd+S");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "p", code: "KeyP", altKey: true });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(onValueChange).toHaveBeenLastCalledWith("Alt+P");
  });

  it("flags a combo Daintree uses and the plugin's own conflicts", () => {
    vi.spyOn(keybindingService, "findConflicts").mockReturnValue([
      {
        actionId: "terminal.new",
        combo: "Cmd+T",
        description: "New terminal",
        kind: "conflict",
      } as never,
    ]);
    render(
      <kit.ShortcutRecorder
        value="Cmd+T"
        getConflict={(combo) => (combo === "Cmd+T" ? "Also opens the sidebar" : null)}
      />
    );
    expect(screen.getByText(/Daintree uses this for New terminal/)).toBeTruthy();
    expect(screen.getByText("Also opens the sidebar")).toBeTruthy();
    expect(recorder().getAttribute("aria-describedby")).toBeTruthy();
  });

  it("releases the app's shortcuts once a combo is recorded", () => {
    render(<kit.ShortcutRecorder />);
    const field = recorder();
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true });
    expect(keybindingService.isCapturingShortcut()).toBe(false);
  });

  it("drops a half-pressed chord when cleared", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    render(<kit.ShortcutRecorder allowChords defaultValue="Cmd+J" onValueChange={onValueChange} />);
    const field = recorder();
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(onValueChange.mock.calls).toEqual([[null]]);
  });

  it("stops recording and releases the app's shortcuts when disabled mid-recording", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    const { rerender } = render(<kit.ShortcutRecorder allowChords onValueChange={onValueChange} />);
    const field = recorder();
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "k", code: "KeyK", ctrlKey: true });
    rerender(<kit.ShortcutRecorder allowChords onValueChange={onValueChange} disabled />);
    expect(keybindingService.isCapturingShortcut()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    fireEvent.keyDown(recorder(), { key: "p", code: "KeyP", ctrlKey: true });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("keeps the caller's description beside its own", () => {
    render(<kit.ShortcutRecorder aria-describedby="hint" />);
    expect(recorder().getAttribute("aria-describedby")?.split(" ")).toContain("hint");
  });

  it("does nothing while disabled", () => {
    render(<kit.ShortcutRecorder disabled value="Cmd+T" checkHostConflicts={false} />);
    const field = recorder();
    expect(field.tabIndex).toBe(-1);
    expect(screen.queryByRole("button", { name: "Clear shortcut" })).toBeNull();
  });
});
