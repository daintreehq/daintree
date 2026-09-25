import "@/lib/trustedTypesPolicy";
import type {
  CdpGetPropertiesResult,
  CdpPropertyDescriptor,
  CdpRemoteArgPrimitive,
} from "@shared/types/ipc/webviewConsole";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported before `./installShims`, which then leaves this bridge in place.
// Expanding an object argument reads its properties over IPC; the generic
// shim would resolve that to undefined and every expansion would fail.
const prop = (name: string, value: CdpRemoteArgPrimitive): CdpPropertyDescriptor => ({
  name,
  value,
  configurable: true,
  enumerable: true,
});

const OBJECT_PROPERTIES: CdpGetPropertiesResult = {
  properties: [
    prop("sku", { type: "primitive", kind: "string", value: "ORC-114" }),
    prop("qty", { type: "primitive", kind: "number", value: 0 }),
    prop("price", { type: "primitive", kind: "undefined", value: null }),
  ],
};

installPreviewShims({
  webview: {
    getConsoleProperties: () => Promise.resolve(OBJECT_PROPERTIES),
    clearConsoleCapture: () => Promise.resolve(),
  },
});
