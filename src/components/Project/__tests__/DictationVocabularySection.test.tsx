/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VoiceDictionaryEntry } from "@shared/types/ipc/api";
import { DictationVocabularySection, parseHeardAs } from "../DictationVocabularySection";

const entry = (term: string, heardAs: string[] = []): VoiceDictionaryEntry => ({
  term,
  heardAs,
  source: "manual",
  addedAt: 0,
});

const api = {
  getProject: vi.fn<(input: { projectId: string }) => Promise<VoiceDictionaryEntry[]>>(),
  addToProject: vi.fn<(input: unknown) => Promise<VoiceDictionaryEntry[]>>(),
  removeFromProject: vi.fn<(input: unknown) => Promise<VoiceDictionaryEntry[]>>(),
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getProject.mockResolvedValue([]);
  vi.stubGlobal("electron", { voiceDictionary: api });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const termInput = () => screen.getByPlaceholderText("Term, as written…") as HTMLInputElement;
const heardAsInput = () => screen.getByLabelText("Heard as") as HTMLInputElement;

describe("parseHeardAs", () => {
  it("splits on commas and drops blanks", () => {
    expect(parseHeardAs(" zoo stand, ,zoo-stand ")).toEqual(["zoo stand", "zoo-stand"]);
  });
});

describe("DictationVocabularySection", () => {
  it("shows the project's terms with how each is heard", async () => {
    api.getProject.mockResolvedValue([entry("Daintree", ["dane tree"]), entry("PtyClient")]);
    render(<DictationVocabularySection projectId="p1" />);
    expect(await screen.findByText("Daintree")).toBeTruthy();
    expect(screen.getByText("Heard as “dane tree”")).toBeTruthy();
    expect(screen.getByText(/^2 terms\./)).toBeTruthy();
    expect(api.getProject).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("adds a term with its heard-as forms and clears the fields once saved", async () => {
    api.addToProject.mockResolvedValue([entry("Zustand", ["zoo stand"])]);
    render(<DictationVocabularySection projectId="p1" />);
    fireEvent.change(termInput(), { target: { value: " Zustand " } });
    fireEvent.change(heardAsInput(), { target: { value: "zoo stand" } });
    fireEvent.keyDown(heardAsInput(), { key: "Enter" });

    expect(await screen.findByText("Zustand")).toBeTruthy();
    expect(api.addToProject).toHaveBeenCalledWith({
      projectId: "p1",
      term: "Zustand",
      heardAs: ["zoo stand"],
    });
    expect(termInput().value).toBe("");
    expect(heardAsInput().value).toBe("");
  });

  it("removes a term and shows the list main returns", async () => {
    api.getProject.mockResolvedValue([entry("Daintree"), entry("PtyClient")]);
    api.removeFromProject.mockResolvedValue([entry("PtyClient")]);
    render(<DictationVocabularySection projectId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Daintree" }));

    await waitFor(() => expect(screen.queryByText("Daintree")).toBeNull());
    expect(api.removeFromProject).toHaveBeenCalledWith({ projectId: "p1", term: "Daintree" });
  });

  it("keeps the draft and offers a retry when a change fails", async () => {
    api.addToProject.mockRejectedValueOnce(new Error("disk full"));
    api.addToProject.mockResolvedValueOnce([entry("Daintree")]);
    render(<DictationVocabularySection projectId="p1" />);
    fireEvent.change(termInput(), { target: { value: "Daintree" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Couldn't save that change")).toBeTruthy();
    expect(termInput().value).toBe("Daintree");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Daintree", { selector: "*:not(input)" })).toBeTruthy();
    expect(screen.queryByText("Couldn't save that change")).toBeNull();
  });

  it("drops a read that lands after the page moved to another project", async () => {
    let resolveFirst!: (entries: VoiceDictionaryEntry[]) => void;
    api.getProject.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)));
    api.getProject.mockResolvedValueOnce([entry("SecondProjectTerm")]);
    const { rerender } = render(<DictationVocabularySection projectId="p1" />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalledWith({ projectId: "p1" }));
    rerender(<DictationVocabularySection projectId="p2" />);
    expect(await screen.findByText("SecondProjectTerm")).toBeTruthy();

    await act(async () => resolveFirst([entry("FirstProjectTerm")]));
    expect(screen.queryByText("FirstProjectTerm")).toBeNull();
    expect(screen.getByText("SecondProjectTerm")).toBeTruthy();
  });

  it("keeps a read that lands late from replacing a change made after it", async () => {
    let resolveRead!: (entries: VoiceDictionaryEntry[]) => void;
    api.getProject.mockReturnValueOnce(new Promise((resolve) => (resolveRead = resolve)));
    api.addToProject.mockResolvedValue([entry("Old"), entry("Added")]);
    render(<DictationVocabularySection projectId="p1" />);
    fireEvent.change(termInput(), { target: { value: "Added" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await act(async () => {});
    expect(api.addToProject).not.toHaveBeenCalled();

    await act(async () => resolveRead([entry("Old")]));
    expect(await screen.findByText("Added", { selector: "*:not(input)" })).toBeTruthy();
    expect(api.addToProject).toHaveBeenCalledTimes(1);
  });

  it("keeps a draft typed while the previous term was saving", async () => {
    let resolveAdd!: (entries: VoiceDictionaryEntry[]) => void;
    api.addToProject.mockReturnValueOnce(new Promise((resolve) => (resolveAdd = resolve)));
    render(<DictationVocabularySection projectId="p1" />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    fireEvent.change(termInput(), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(termInput(), { target: { value: "Second" } });

    await act(async () => resolveAdd([entry("First")]));
    expect(screen.getByText("First")).toBeTruthy();
    expect(termInput().value).toBe("Second");
  });

  it("keeps the whole draft when only its heard-as forms changed during the save", async () => {
    let resolveAdd!: (entries: VoiceDictionaryEntry[]) => void;
    api.addToProject.mockReturnValueOnce(new Promise((resolve) => (resolveAdd = resolve)));
    render(<DictationVocabularySection projectId="p1" />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    fireEvent.change(termInput(), { target: { value: "Zustand" } });
    fireEvent.change(heardAsInput(), { target: { value: "zoo stand" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(heardAsInput(), { target: { value: "zoo-stand" } });

    await act(async () => resolveAdd([entry("Zustand", ["zoo stand"])]));
    expect(termInput().value).toBe("Zustand");
    expect(heardAsInput().value).toBe("zoo-stand");
  });
});
