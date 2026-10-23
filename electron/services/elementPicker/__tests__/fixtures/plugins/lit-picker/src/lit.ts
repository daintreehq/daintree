/// <reference lib="dom" />
/**
 * The fixture's guest entry, written as an author would against
 * `@daintreehq/plugin-sdk/element-picker` (whose `defineElementPickerExtractor`
 * is an identity function, so it is left out here to keep the fixture free of
 * a cross-project import). Reads only what a Lit element exposes without a dev
 * build — its tag — and invents no file or line: a position comes only from
 * the `data-fixture-lit-source` stamp a dev build of the fixture app writes,
 * `path:line:column`, both 1-based.
 */
const SOURCE_ATTRIBUTE = "data-fixture-lit-source";
const SOURCE_STAMP = /^(.+):(\d+):(\d+)$/;

export default function createLitExtractor(providerId: string) {
  return {
    extract(element: Element, phase: "hover" | "selection") {
      const root = element.getRootNode();
      const host = root instanceof ShadowRoot ? root.host : element;
      if (!host.localName.includes("-")) return null;
      const stamp = phase === "selection" ? host.getAttribute(SOURCE_ATTRIBUTE) : null;
      const match = stamp ? SOURCE_STAMP.exec(stamp) : null;
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
        ...(match
          ? {
              sourceCandidates: [
                {
                  kind: "template-location",
                  candidateId: "lit-source",
                  framework: providerId,
                  extraction: { kind: "attribute", attribute: SOURCE_ATTRIBUTE },
                  file: match[1],
                  location: {
                    lineBase: 1,
                    columnBase: 1,
                    columnUnit: "utf16",
                    line: Number(match[2]),
                    column: Number(match[3]),
                  },
                },
              ],
            }
          : {}),
      };
    },
  };
}
