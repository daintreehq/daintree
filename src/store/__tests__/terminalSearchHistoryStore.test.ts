// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalSearchHistoryStore } from "../terminalSearchHistoryStore";

describe("terminalSearchHistoryStore", () => {
  beforeEach(() => {
    useTerminalSearchHistoryStore.setState({
      searches: [],
      caseSensitive: false,
      regexEnabled: false,
    });
  });

  it("addSearch prepends a new term", () => {
    useTerminalSearchHistoryStore.getState().addSearch("hello");
    expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["hello"]);
  });

  it("addSearch trims and ignores blank input", () => {
    const { addSearch } = useTerminalSearchHistoryStore.getState();
    addSearch("");
    addSearch("   ");
    expect(useTerminalSearchHistoryStore.getState().searches).toEqual([]);

    addSearch("  spaced  ");
    expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["spaced"]);
  });

  it("addSearch deduplicates by exact-string match (moves to front)", () => {
    const { addSearch } = useTerminalSearchHistoryStore.getState();
    addSearch("one");
    addSearch("two");
    addSearch("one");
    expect(useTerminalSearchHistoryStore.getState().searches).toEqual(["one", "two"]);
  });

  it("addSearch caps history at 50 entries", () => {
    const { addSearch } = useTerminalSearchHistoryStore.getState();
    for (let i = 0; i < 60; i++) {
      addSearch(`term-${i}`);
    }
    const searches = useTerminalSearchHistoryStore.getState().searches;
    expect(searches).toHaveLength(50);
    expect(searches[0]).toBe("term-59");
    expect(searches[49]).toBe("term-10");
  });

  it("setToggles updates persisted toggle state", () => {
    useTerminalSearchHistoryStore.getState().setToggles(true, false);
    let state = useTerminalSearchHistoryStore.getState();
    expect(state.caseSensitive).toBe(true);
    expect(state.regexEnabled).toBe(false);

    useTerminalSearchHistoryStore.getState().setToggles(false, true);
    state = useTerminalSearchHistoryStore.getState();
    expect(state.caseSensitive).toBe(false);
    expect(state.regexEnabled).toBe(true);
  });

  it("registers a persist getOptions name", () => {
    const options = useTerminalSearchHistoryStore.persist.getOptions();
    expect(options.name).toBe("daintree-terminal-search-history");
  });
});
