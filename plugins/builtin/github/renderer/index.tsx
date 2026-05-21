import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { BulkCreateWorktreeDialog } from "./components/BulkCreateWorktreeDialog";
import { IssueSelector } from "./components/IssueSelector";

// Registration runs at module-load time. The host bootstrap imports this
// module once at app start so plugin slots are populated before any host
// dialog tries to resolve them. Slot ids stay dot-namespaced by plugin so
// future forge plugins can fill the same seams without colliding.
registerBuiltinView("github.bulkCreateWorktreeDialog", BulkCreateWorktreeDialog);
registerBuiltinView("github.issueSelector", IssueSelector);
