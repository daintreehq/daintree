import { describe, expect, it } from "vitest";
import * as sdkReact from "../../../packages/plugin-sdk/src/react";
import { PLUGIN_SDK_REACT_RUNTIME_EXPORTS } from "../runtimeExports";

describe("PLUGIN_SDK_REACT_RUNTIME_EXPORTS", () => {
  it("is exactly the runtime surface of @daintreehq/plugin-sdk/react", () => {
    // The host build holds its raw-view facade to this list in both directions,
    // so a hook added to or dropped from the SDK entry must land here too.
    expect([...PLUGIN_SDK_REACT_RUNTIME_EXPORTS].sort()).toEqual(Object.keys(sdkReact).sort());
  });

  it("has no duplicates", () => {
    expect(new Set(PLUGIN_SDK_REACT_RUNTIME_EXPORTS).size).toBe(
      PLUGIN_SDK_REACT_RUNTIME_EXPORTS.length
    );
  });
});
