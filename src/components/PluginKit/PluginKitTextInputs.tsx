import { KitComposer, KitMentionTextarea } from "./PluginKitMentionComposer";
import { KitInlineEdit } from "./PluginKitInlineEdit";
import { KitSecretInput } from "./PluginKitSecretInput";
import { KitKeyValueEditor, KitListEditor } from "./PluginKitCollectionEditors";
import { KitShortcutRecorder } from "./PluginKitShortcutRecorder";

export { findMentionSession, insertMention } from "./PluginKitMentionComposer";
export { keyValueErrors, listErrors, parseAssignments } from "./PluginKitCollectionEditors";

export const pluginKitTextInputs = {
  MentionTextarea: KitMentionTextarea,
  Composer: KitComposer,
  InlineEdit: KitInlineEdit,
  KeyValueEditor: KitKeyValueEditor,
  ListEditor: KitListEditor,
  SecretInput: KitSecretInput,
  ShortcutRecorder: KitShortcutRecorder,
};
