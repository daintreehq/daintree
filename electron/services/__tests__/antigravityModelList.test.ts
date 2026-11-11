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
    expect(
      parseAgyModelsOutput("\r\x1b[2K⣷  Fetching models…\r\x1b[2K⣯  Fetching models…")
    ).toEqual([]);
  });

  it("skips column headers, labelled notices, prose and single-space pairs", () => {
    const output = [
      "ID                    NAME",
      "model                 name",
      "MODEL_ID              DISPLAY NAME",
      "WARNING  Some models are unavailable on this plan",
      "agy  A new version is available: run agy update",
      "login  Authenticate with Google",
      "https://antigravity.google/auth  Open this URL to sign in",
      "https://accounts-google.example/sign-in  Open this URL to sign in",
      "Available models (2):",
      "Note: some models need a paid plan",
      "Warning:  quota is low on this account",
      "",
      "gemini-4-carbon-high  Gemini 4 Carbon (High)",
      "default gemini-4-carbon-high",
      "   ",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n");
    expect(parseAgyModelsOutput(output)).toEqual([
      { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ]);
  });

  it("reads past OSC sequences terminated by BEL or ST, and a last row with no newline", () => {
    const output = [
      "\x1b]0;agy\x07\x1b]8;;https://antigravity.google/models\x1b\\gemini-4-carbon-high\x1b]8;;\x1b\\  Gemini 4 Carbon (High)",
      "\x1b]8;;https://antigravity.google/models\x07gemini-4-argon-high\x1b]8;;\x07  Gemini 4 Argon (High)",
    ].join("\n");
    expect(parseAgyModelsOutput(output)).toEqual([
      { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    ]);
  });

  it.each(["*", ">", "•", "●", "✓"])("reads a row marked %s as the current choice", (marker) => {
    expect(parseAgyModelsOutput(`${marker} gemini-4-carbon-high  Gemini 4 Carbon (High)`)).toEqual([
      { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
    ]);
  });

  it("reads a marked row among unmarked ones and keeps the first of a repeated id", () => {
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
