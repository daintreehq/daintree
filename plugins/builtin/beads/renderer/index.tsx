import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { BeadsIcon } from "@/components/icons/brands";

// The id must match the manifest's `slots.icon` value exactly. No settings tab:
// Settings → Code forge renders the declared `credentialFields` itself, and the
// server URL is a project setting.
registerBuiltinView("beads.providerIcon", BeadsIcon, { pluginId: "daintree.beads" });
