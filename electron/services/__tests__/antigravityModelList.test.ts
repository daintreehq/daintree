import { describe, expect, it } from "vitest";

import { parseAgyModelsOutput } from "../antigravityModelList.js";
import {
  AGY_MODELS,
  AGY_MODELS_OFFLINE,
  AGY_MODELS_SPINNER_CLEARED,
  AGY_MODELS_SPINNER_OVERWRITTEN,
  AGY_MODELS_STYLED,
  AGY_MODELS_WINDOWS,
} from "./fixtures/agyModelsOutput.js";

describe("parseAgyModelsOutput", () => {
  it.each([
    ["spinner erased before the rows", AGY_MODELS_SPINNER_CLEARED],
    ["first row written over the last spinner frame", AGY_MODELS_SPINNER_OVERWRITTEN],
    ["CRLF line ends with spinner frames on their own lines", AGY_MODELS_WINDOWS],
    ["SGR-styled rows", AGY_MODELS_STYLED],
  ])("reads every row, in order, from %s", (_label, output) => {
    expect(parseAgyModelsOutput(output)).toEqual(AGY_MODELS);
  });

  it("finds no rows in an offline failure", () => {
    expect(parseAgyModelsOutput(AGY_MODELS_OFFLINE)).toEqual([]);
  });

  it("finds no rows in empty or spinner-only output", () => {
    expect(parseAgyModelsOutput("")).toEqual([]);
    expect(parseAgyModelsOutput("\r\x1b[2K⣷  Fetching models…\r\x1b[2K⣯  Fetching models…")).toEqual(
      []
    );
  });

  it("skips a column header, prose and single-space pairs", () => {
    const output = [
      "ID                    NAME",
      "Available models (2):",
      "Note: some models need a paid plan",
      "gemini-4-carbon-high  Gemini 4 Carbon (High)",
      "default gemini-4-carbon-high",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n");
    expect(parseAgyModelsOutput(output)).toEqual([
      { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ]);
  });

  it("reads a row marked as the current choice and keeps the first of a repeated id", () => {
    const output = [
      "* gemini-4-carbon-high  Gemini 4 Carbon (High)",
      "  gemini-4-argon-high   Gemini 4 Argon (High)",
      "gemini-4-carbon-high    Duplicate",
    ].join("\n");
    expect(parseAgyModelsOutput(output)).toEqual([
      { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    ]);
  });
});
