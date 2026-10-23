import { defineElementPickerExtractor } from "../../../../../../../../packages/plugin-sdk/src/element-picker.js";

/**
 * Reads only what a Lit element exposes without a dev build: its tag, and
 * whether it renders into a shadow root. It invents no file or line.
 */
export default defineElementPickerExtractor((providerId) => ({
  extract(element, phase) {
    const host =
      element.getRootNode() instanceof ShadowRoot
        ? (element.getRootNode() as ShadowRoot).host
        : element;
    if (!host.localName.includes("-")) return null;
    return {
      frameworkEvidence: [
        {
          kind: "generic",
          framework: providerId,
          fields: [
            { name: "tag", value: host.localName },
            { name: "phase", value: phase },
          ],
        },
      ],
    };
  },
}));
