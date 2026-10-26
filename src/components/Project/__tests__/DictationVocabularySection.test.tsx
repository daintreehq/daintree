/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  (window as unknown as { electron: unknown }).electron = { voiceDictionary: api };
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
    rerender(<DictationVocabularySection projectId="p2" />);
    expect(await screen.findByText("SecondProjectTerm")).toBeTruthy();

    resolveFirst([entry("FirstProjectTerm")]);
    await Promise.resolve();
    expect(screen.queryByText("FirstProjectTerm")).toBeNull();
  });
});
