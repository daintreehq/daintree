import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { LinearIcon } from "@/components/icons/brands";

// The id must match the manifest's `slots.icon` value exactly. No settings tab:
// Settings → Code forge renders the declared `credentialFields` itself, and the
// team key is a project setting.
registerBuiltinView("linear.providerIcon", LinearIcon, { pluginId: "daintree.linear" });
