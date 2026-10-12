import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { patchNodePtyConptySource } from "./patchNodePtyConpty.cjs";

const BETA_14 = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "node-pty-conpty-beta14.cc"),
  "utf8"
);
const INSTALLED = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "node-pty",
  "src",
  "win",
  "conpty.cc"
);

function at(source: string, text: string): number {
  const index = source.indexOf(text);
  expect(index, text).toBeGreaterThan(-1);
  return index;
}

describe("patchNodePtyConptySource", () => {
  const patched = patchNodePtyConptySource(BETA_14);

  it("hands the pseudoconsole to the exit callback before the watcher erases the baton", () => {
    const handOff = at(patched, "exit_event->hpc = baton->hpc;");
    expect(at(patched, "baton->hpc = nullptr;")).toBeGreaterThan(handOff);
    expect(at(patched, "std::erase_if(ptyHandles")).toBeGreaterThan(handOff);
  });

  it("closes it only after JS has the exit code, off the main thread", () => {
    const call = at(patched, "cb.Call({Napi::Number::New(env, exit_event->exit_code)});");
    const close = at(patched, "pfnClose(hpc);");
    expect(close).toBeGreaterThan(call);
    expect(at(patched, "}).detach();")).toBeGreaterThan(close);
    expect(at(patched, "delete exit_event;")).toBeGreaterThan(close);
  });

  it("resolves the close function before the exit watcher starts", () => {
    const resolve = at(
      patched,
      "handle->pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress("
    );
    expect(at(patched, "SetupExitCallback(env, exitCallback, handle);")).toBeGreaterThan(resolve);
  });

  it("makes kill() close the pseudoconsole at most once", () => {
    const guard = at(patched, "if (pfnClosePseudoConsole && handle->hpc != nullptr)");
    expect(patched.indexOf("handle->hpc = nullptr;", guard)).toBeGreaterThan(guard);
  });

  it("is idempotent", () => {
    expect(patchNodePtyConptySource(patched)).toBe(patched);
  });

  it("keeps CRLF line endings", () => {
    const crlf = BETA_14.replace(/\n/g, "\r\n");
    expect(patchNodePtyConptySource(crlf)).toBe(patched.replace(/\n/g, "\r\n"));
  });

  it("refuses a conpty.cc it does not recognise", () => {
    const moved = BETA_14.replace("      const int id = baton->id;\n", "");
    expect(() => patchNodePtyConptySource(moved)).toThrow(/exit watcher hand-off.*#965/);

    const doubled = BETA_14.replace(
      "struct ExitEvent {",
      "struct ExitEvent {\n  int exit_code = 0;\n};\nstruct ExitEvent {"
    );
    expect(() => patchNodePtyConptySource(doubled)).toThrow(/ExitEvent pseudoconsole/);
  });

  it("applies to the installed node-pty", () => {
    const installed = fs.readFileSync(INSTALLED, "utf8");
    const result = patchNodePtyConptySource(installed);
    expect(patchNodePtyConptySource(result)).toBe(result);
    expect(result).toContain("exit_event->hpc = baton->hpc;");
  });
});
