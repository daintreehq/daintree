/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  HeardAsConflict,
  ProjectVoiceDictionaryChange,
  VoiceDictionaryEntry,
} from "@shared/types/ipc/api";
import { DictationVocabularySection, parseHeardAs } from "../DictationVocabularySection";

const entry = (term: string, heardAs: string[] = []): VoiceDictionaryEntry => ({
  term,
  heardAs,
  source: "manual",
  addedAt: 0,
});

const changed = (
  dictionary: VoiceDictionaryEntry[],
  conflicts: HeardAsConflict[] = []
): ProjectVoiceDictionaryChange => ({ dictionary, conflicts });

const api = {
  getProject: vi.fn<(input: { projectId: string }) => Promise<VoiceDictionaryEntry[]>>(),
  addToProject: vi.fn<(input: unknown) => Promise<ProjectVoiceDictionaryChange>>(),
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
    api.addToProject.mockResolvedValue(changed([entry("Zustand", ["zoo stand"])]));
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
    api.addToProject.mockResolvedValueOnce(changed([entry("Daintree")]));
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
    api.addToProject.mockResolvedValue(changed([entry("Old"), entry("Added")]));
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
    let resolveAdd!: (change: ProjectVoiceDictionaryChange) => void;
    api.addToProject.mockReturnValueOnce(new Promise((resolve) => (resolveAdd = resolve)));
    render(<DictationVocabularySection projectId="p1" />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    fireEvent.change(termInput(), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(termInput(), { target: { value: "Second" } });

    await act(async () => resolveAdd(changed([entry("First")])));
    expect(screen.getByText("First")).toBeTruthy();
    expect(termInput().value).toBe("Second");
  });

  it("keeps the whole draft when only its heard-as forms changed during the save", async () => {
    let resolveAdd!: (change: ProjectVoiceDictionaryChange) => void;
    api.addToProject.mockReturnValueOnce(new Promise((resolve) => (resolveAdd = resolve)));
    render(<DictationVocabularySection projectId="p1" />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    fireEvent.change(termInput(), { target: { value: "Zustand" } });
    fireEvent.change(heardAsInput(), { target: { value: "zoo stand" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(heardAsInput(), { target: { value: "zoo-stand" } });

    await act(async () => resolveAdd(changed([entry("Zustand", ["zoo stand"])])));
    expect(termInput().value).toBe("Zustand");
    expect(heardAsInput().value).toBe("zoo-stand");
  });

  describe("a heard-as phrase another term already has", () => {
    it("asks before moving it, and moves it on Move", async () => {
      api.getProject.mockResolvedValue([entry("Zustand", ["zoo stand"])]);
      api.addToProject.mockResolvedValue(
        changed([entry("Zustand"), entry("Zoostand", ["Zoo Stand"])])
      );
      render(<DictationVocabularySection projectId="p1" />);
      await screen.findByText("Zustand");
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("");
      fireEvent.change(termInput(), { target: { value: "Zoostand" } });
      fireEvent.change(heardAsInput(), { target: { value: "Zoo Stand" } });
      act(() => heardAsInput().focus());
      fireEvent.keyDown(heardAsInput(), { key: "Enter" });

      expect(screen.getByRole("status")).toBe(status);
      expect(document.activeElement).toBe(heardAsInput());
      const question = "“Zoo Stand” already belongs to Zustand. Move it to Zoostand?";
      expect(screen.getByRole("status").textContent).toBe(question);
      expect(screen.getAllByText(question)).toHaveLength(2);
      expect(api.addToProject).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Move phrase" }));
      await waitFor(() => expect(termInput().value).toBe(""));
      expect(api.addToProject).toHaveBeenCalledWith({
        projectId: "p1",
        term: "Zoostand",
        heardAs: ["Zoo Stand"],
        heardAsConflict: "move",
      });
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
    });

    it("keeps the draft on Cancel, and drops the question once the draft changes", async () => {
      api.getProject.mockResolvedValue([entry("Zustand", ["zoo stand"])]);
      render(<DictationVocabularySection projectId="p1" />);
      await screen.findByText("Zustand");
      fireEvent.change(termInput(), { target: { value: "Zoostand" } });
      fireEvent.change(heardAsInput(), { target: { value: "zoo stand" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
      expect(termInput().value).toBe("Zoostand");
      expect(document.activeElement).toBe(termInput());

      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(screen.getByRole("button", { name: "Move phrase" })).toBeTruthy();
      fireEvent.change(heardAsInput(), { target: { value: "zoo-stand" } });
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
      expect(api.addToProject).not.toHaveBeenCalled();
    });

    it("asks the same question when main refuses a phrase taken since the list was read", async () => {
      api.addToProject.mockResolvedValue(
        changed([entry("Zustand", ["zoo stand"])], [{ phrase: "zoo stand", owner: "Zustand" }])
      );
      render(<DictationVocabularySection projectId="p1" />);
      await waitFor(() => expect(api.getProject).toHaveBeenCalled());
      fireEvent.change(termInput(), { target: { value: "Zoostand" } });
      fireEvent.change(heardAsInput(), { target: { value: "zoo stand" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(await screen.findByRole("button", { name: "Move phrase" })).toBeTruthy();
      expect(screen.getByText("Zustand")).toBeTruthy();
      expect(termInput().value).toBe("Zoostand");
    });

    it("says a refused add wasn't saved when the draft has moved on", async () => {
      let resolveAdd!: (change: ProjectVoiceDictionaryChange) => void;
      api.addToProject.mockReturnValueOnce(new Promise((resolve) => (resolveAdd = resolve)));
      render(<DictationVocabularySection projectId="p1" />);
      await waitFor(() => expect(api.getProject).toHaveBeenCalled());
      fireEvent.change(termInput(), { target: { value: "Zoostand" } });
      fireEvent.change(heardAsInput(), { target: { value: "zoo stand" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.change(termInput(), { target: { value: "Vite" } });

      await act(async () =>
        resolveAdd(
          changed([entry("Zustand", ["zoo stand"])], [{ phrase: "zoo stand", owner: "Zustand" }])
        )
      );
      const notice = "Didn't add Zoostand: “zoo stand” already belongs to Zustand";
      expect(screen.getByRole("status").textContent).toBe(notice);
      expect(screen.getAllByText(notice)).toHaveLength(2);
      expect(termInput().value).toBe("Vite");
      expect(screen.queryByRole("button", { name: "Move phrase" })).toBeNull();
    });

    it("marks a phrase stored twice on the entry it never fires for", async () => {
      api.getProject.mockResolvedValue([
        entry("Zustand", ["zoo stand"]),
        entry("Zoostand", ["Zoo  Stand", "zoo-stand"]),
      ]);
      render(<DictationVocabularySection projectId="p1" />);
      await screen.findByText("Zoostand");
      expect(screen.getByText(/Not used/).textContent).toBe(
        "Heard as “Zoo  Stand”, “zoo-stand”. Not used: “Zoo  Stand” already belongs to Zustand"
      );
      expect(screen.getByText("Heard as “zoo stand”")).toBeTruthy();
    });
  });
});
