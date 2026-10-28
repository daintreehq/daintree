import { BrowserWindow, dialog } from "electron";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  PluginSettingsScope,
  PluginSettingsUiValues,
  PluginAccountUiStatus,
  PluginAccountConnectResult,
  PluginAccountVerification,
  PluginAccountBindingUiStatus,
  PluginAccountBinding,
  PluginRequiredSettingsStatus,
  PluginSetupUiStatus,
  PluginPickPathRequest,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import {
  projectIdFromPluginInstanceKey,
  isSafePluginInstanceId,
} from "../../../services/plugin/projectPluginIdentity.js";
import { remoteAccountSignIn } from "../../../services/plugin/remoteAccountSignIn.js";
import type { AccountSignInBroker } from "../../../services/plugin/PluginAccountService.js";
import { getPluginService } from "./service.js";
import { isRemoteCaller } from "./senderScope.js";

// ── Plugin settings UI bridge (#9301) ─────────────────────────────────────

/**
 * Settings reads and writes answer only to a renderer that owns the project
 * they name.
 *
 * `PluginSettingsManager` checks that the supplied `pluginId` and `projectId`
 * agree with each other, but never that the *sender* owns that project. An
 * instance key is not a secret, so without this a renderer for project B that
 * knows A's ids could read — or with `revealSecret`, decrypt — project A's
 * plugin settings. Both halves are checked: the id the caller names, and the
 * project the plugin instance itself belongs to.
 *
 * `projectId: null` is the legitimate `"user"`-scope case and needs no owner.
 */
function assertSenderOwnsSettingsTarget(
  ctx: IpcContext,
  pluginId: string,
  projectId: string | null
): void {
  if (projectId !== null && projectId !== ctx.projectId) {
    throw new Error("plugin settings rejected: sender belongs to a different project");
  }
  const boundProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (boundProjectId !== null && boundProjectId !== ctx.projectId) {
    throw new Error("plugin settings rejected: plugin belongs to a different project");
  }
}

export async function handleSettingsGetValues(
  ctx: IpcContext,
  pluginId: string,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<PluginSettingsUiValues> {
  assertSenderOwnsSettingsTarget(ctx, pluginId, projectId);
  return (await getPluginService()).getSettingValuesForUi(pluginId, scope, projectId);
}

export async function handleSettingsSetValue(
  ctx: IpcContext,
  pluginId: string,
  key: string,
  value: unknown,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<void> {
  assertSenderOwnsSettingsTarget(ctx, pluginId, projectId);
  await (await getPluginService()).setSettingValueFromUi(pluginId, key, value, scope, projectId);
}

export async function handleSettingsDeleteValue(
  ctx: IpcContext,
  pluginId: string,
  key: string,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<void> {
  assertSenderOwnsSettingsTarget(ctx, pluginId, projectId);
  await (await getPluginService()).deleteSettingValueFromUi(pluginId, key, scope, projectId);
}

export async function handleSettingsRevealSecret(
  ctx: IpcContext,
  pluginId: string,
  key: string,
  scope: PluginSettingsScope,
  projectId: string | null
): Promise<string | null> {
  assertSenderOwnsSettingsTarget(ctx, pluginId, projectId);
  return (await getPluginService()).revealSecretSettingForUi(pluginId, key, scope, projectId);
}

/**
 * The account channels name only the plugin. A project plugin's account
 * belongs to its project, so only that project's views may see or change it;
 * an installed plugin's account is this machine's, like its user settings.
 */
function assertSenderOwnsAccount(ctx: IpcContext, pluginId: unknown): asserts pluginId is string {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("plugin account rejected: invalid plugin id");
  }
  const boundProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (boundProjectId !== null && boundProjectId !== ctx.projectId) {
    throw new Error("plugin account rejected: plugin belongs to a different project");
  }
}

/** A connection id from the renderer: absent, or a string the account service checks. */
function assertConnectionId(connectionId: unknown): asserts connectionId is string | undefined {
  if (connectionId !== undefined && typeof connectionId !== "string") {
    throw new Error("plugin account rejected: invalid connection id");
  }
}

export async function handleAccountStatus(
  ctx: IpcContext,
  pluginId: string,
  connectionId?: string
): Promise<PluginAccountUiStatus | null> {
  assertSenderOwnsAccount(ctx, pluginId);
  assertConnectionId(connectionId);
  return (await getPluginService()).getAccountStatusForUi(pluginId, connectionId);
}

export async function handleAccountList(
  ctx: IpcContext,
  pluginId: string
): Promise<PluginAccountUiStatus[]> {
  assertSenderOwnsAccount(ctx, pluginId);
  return (await getPluginService()).listAccountConnectionsForUi(pluginId);
}

/**
 * The sign-in runs here and the tokens are kept here. A window on another
 * machine signs in with that machine's browser: its own Shell catches the
 * redirect and hands back only the code. That Shell names the click
 * (`signInId`) so its browser opens for this sign-in and no other; a local
 * window has no use for one.
 */
export async function handleAccountConnect(
  ctx: IpcContext,
  pluginId: string,
  connectionId?: string,
  signInId?: string
): Promise<PluginAccountConnectResult> {
  assertSenderOwnsAccount(ctx, pluginId);
  assertConnectionId(connectionId);
  let broker: AccountSignInBroker | undefined;
  if (isRemoteCaller(ctx)) {
    if (typeof signInId !== "string" || signInId.length === 0 || signInId.length > 128) {
      throw new Error("plugin account rejected: the window named no sign-in");
    }
    broker = remoteAccountSignIn(ctx.endpoint, pluginId, connectionId, signInId);
  }
  return (await getPluginService()).connectAccountFromUi(pluginId, connectionId, broker);
}

export async function handleAccountCancelConnect(
  ctx: IpcContext,
  pluginId: string,
  connectionId?: string
): Promise<void> {
  assertSenderOwnsAccount(ctx, pluginId);
  assertConnectionId(connectionId);
  (await getPluginService()).cancelAccountConnectFromUi(pluginId, connectionId);
}

export async function handleAccountSetToken(
  ctx: IpcContext,
  pluginId: string,
  token: string,
  connectionId?: string
): Promise<PluginAccountUiStatus> {
  assertSenderOwnsAccount(ctx, pluginId);
  assertConnectionId(connectionId);
  return (await getPluginService()).setAccountTokenFromUi(pluginId, token, connectionId);
}

export async function handleAccountDisconnect(
  ctx: IpcContext,
  pluginId: string,
  connectionId?: string
): Promise<void> {
  assertSenderOwnsAccount(ctx, pluginId);
  assertConnectionId(connectionId);
  await (await getPluginService()).disconnectAccountFromUi(pluginId, connectionId);
}

export async function handleAccountTest(
  ctx: IpcContext,
  pluginId: string,
  connectionId?: string
): Promise<PluginAccountVerification> {
  assertSenderOwnsAccount(ctx, pluginId);
  assertConnectionId(connectionId);
  return (await getPluginService()).testAccountConnectionFromUi(pluginId, connectionId);
}

/**
 * Bindings are always the sender's own project's: no channel names a project,
 * so a window can neither read nor change another project's choice.
 */
function requireSenderProject(ctx: IpcContext): string {
  if (ctx.projectId === null) {
    throw new Error("plugin account rejected: open a project to choose its connection");
  }
  return ctx.projectId;
}

export async function handleAccountBindingGet(
  ctx: IpcContext,
  pluginId: string
): Promise<PluginAccountBindingUiStatus> {
  assertSenderOwnsAccount(ctx, pluginId);
  return (await getPluginService()).getAccountBindingForUi(pluginId, requireSenderProject(ctx));
}

export async function handleAccountBindingSet(
  ctx: IpcContext,
  pluginId: string,
  binding: PluginAccountBinding | null
): Promise<PluginAccountBindingUiStatus> {
  assertSenderOwnsAccount(ctx, pluginId);
  const projectId = requireSenderProject(ctx);
  if (binding !== null) {
    if (
      typeof binding !== "object" ||
      typeof binding.connectionId !== "string" ||
      (binding.source !== "own" && binding.source !== "machine")
    ) {
      throw new Error("plugin account rejected: invalid binding");
    }
  }
  const next =
    binding === null ? null : { connectionId: binding.connectionId, source: binding.source };
  return (await getPluginService()).setAccountBindingFromUi(pluginId, projectId, next);
}

/**
 * Which declared `required` settings `pluginId` still has unset (and which
 * couldn't be read), against the sender's own project. Ids only — never a value
 * — so this is safe to poll from every open panel of the plugin.
 */
export async function handleSettingsRequiredStatus(
  ctx: IpcContext,
  pluginId: string,
  projectId: string | null
): Promise<PluginRequiredSettingsStatus> {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("plugin settings rejected: invalid plugin id");
  }
  assertSenderOwnsSettingsTarget(ctx, pluginId, projectId);
  return (await getPluginService()).getRequiredSettingsStatusForUi(pluginId, projectId);
}

/**
 * `pluginId`'s setup checklist (#13824) against the sender's own project. No
 * values cross: a setting step says only whether something is stored.
 */
export async function handleSetupStatus(
  ctx: IpcContext,
  pluginId: string,
  projectId: string | null
): Promise<PluginSetupUiStatus> {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("plugin setup rejected: invalid plugin id");
  }
  assertSenderOwnsSettingsTarget(ctx, pluginId, projectId);
  return (await getPluginService()).getSetupStatusForUi(pluginId, projectId);
}

/** Skip or restore one setup step in the SENDER's project; a skip is never remembered without one. */
export async function handleSetupStepSkippedSet(
  ctx: IpcContext,
  pluginId: string,
  stepId: string,
  skipped: boolean
): Promise<void> {
  if (!ctx.projectId) throw new Error("plugin setup: sender has no project");
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("plugin setup rejected: invalid plugin id");
  }
  if (typeof stepId !== "string") throw new Error("plugin setup: malformed step id");
  if (typeof skipped !== "boolean") throw new Error("plugin setup: malformed skipped flag");
  assertSenderOwnsSettingsTarget(ctx, pluginId, ctx.projectId);
  (await getPluginService()).setSetupStepSkippedFromUi(ctx.projectId, pluginId, stepId, skipped);
}

// Native folder/file chooser for `path` / `directory` / `file` settings fields.
// User-initiated from the settings form's "Browse" button, so it carries no
// capability gate — but `pluginId` must be a well-formed scoped name so the
// surface stays bounded to an actual plugin (mirrors handleUninstall's guard).
// Reuses the install flow's showOpenDialog pattern. Returns the chosen absolute
// path, or null when the picker is dismissed.
export async function handlePickPath(
  ctx: IpcContext,
  pluginId: string,
  request: PluginPickPathRequest
): Promise<string | null> {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("pickPath: pluginId must be a scoped plugin name (publisher.name)");
  }
  const isDirectory = request.kind === "directory";
  const properties: Array<"openFile" | "openDirectory"> = isDirectory
    ? ["openDirectory"]
    : ["openFile"];
  const filters =
    !isDirectory && request.filters && request.filters.length > 0
      ? request.filters.map((f) => ({ name: f.name, extensions: f.extensions }))
      : undefined;
  const defaultPath =
    typeof request.defaultPath === "string" && isAbsolute(request.defaultPath)
      ? request.defaultPath
      : undefined;
  const dialogOptions = {
    title: isDirectory ? "Choose folder" : "Choose file",
    properties,
    ...(filters ? { filters } : {}),
    ...(defaultPath ? { defaultPath } : {}),
  };
  const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0]!;
}

// Existence probe for `mustExist` path/directory/file settings. The settings form
// flags a stored path that no longer resolves on disk (it may have been moved or
// deleted since it was picked). Scoped to a valid pluginId; a non-absolute path
// resolves false rather than throwing so a stale stored value can't crash the
// form.
export async function handlePathExists(pluginId: string, targetPath: string): Promise<boolean> {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("pathExists: pluginId must be a scoped plugin name (publisher.name)");
  }
  if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
    return false;
  }
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
