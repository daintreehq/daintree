import { useId, useRef } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Callout } from "@/components/ui/Callout";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/Spinner";
import type { SshSignInPrompt, SshSignInState } from "./useSshSignIn";

const PROMPT_TEXT_CLASS =
  "max-h-48 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-primary select-text";

/**
 * ssh's own questions while it signs in to a host: a passphrase, a password,
 * a code, or a security key to touch. Each is shown as ssh wrote it; what is
 * typed goes to ssh and nowhere else. The field is uncontrolled and keyed by
 * its question, so nothing typed outlives the question it was typed for.
 */
export function SshSignInDialog({
  hostLabel,
  state,
  onAnswer,
  onRetry,
  onClose,
}: {
  hostLabel: string;
  state: SshSignInState;
  onAnswer: (prompt: SshSignInPrompt, text: string) => void;
  onRetry: () => void;
  /** Cancel a running sign-in, or put a failed one away. */
  onClose: () => void;
}) {
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const promptTextId = useId();
  const prompt = state.phase === "signing-in" ? state.prompt : null;
  const error = state.phase === "signing-in" ? state.error : undefined;
  const submit = () => {
    const field = fieldRef.current;
    if (!prompt || prompt.kind !== "secret" || !field) return;
    const text = field.value;
    field.value = "";
    onAnswer(prompt, text);
  };

  let body: React.ReactNode = null;
  let primary: DialogAction | undefined;
  if (state.phase === "failed") {
    body = (
      <Callout severity="error" title="ssh didn't get in" role="alert">
        <p className="select-text">{state.detail}</p>
      </Callout>
    );
    primary = { label: "Try again", onClick: onRetry };
  } else if (prompt?.kind === "secret") {
    body = (
      <div className="space-y-3">
        <pre id={promptTextId} className={PROMPT_TEXT_CLASS} data-testid="ssh-sign-in-prompt">
          {prompt.text}
        </pre>
        <Field>
          <FieldLabel className="sr-only">Answer for ssh</FieldLabel>
          <Input
            key={prompt.id}
            ref={fieldRef}
            type="password"
            defaultValue=""
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            aria-describedby={promptTextId}
            data-testid="ssh-sign-in-answer"
            onKeyDown={(event) => {
              // Enter that commits an IME candidate, or one held down from the last question, isn't an answer.
              if (
                event.key !== "Enter" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.repeat
              ) {
                return;
              }
              event.preventDefault();
              submit();
            }}
          />
          {error && <FieldError role="alert">{error}</FieldError>}
        </Field>
      </div>
    );
    primary = { label: "Continue", onClick: submit };
  } else if (prompt) {
    body = (
      <div className="space-y-3" role="status">
        <pre className={PROMPT_TEXT_CLASS} data-testid="ssh-sign-in-prompt">
          {prompt.text}
        </pre>
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner size="sm" />
          Waiting for ssh…
        </p>
      </div>
    );
  } else if (state.phase === "signing-in") {
    body = (
      <p className="flex items-center gap-2 text-sm text-text-secondary" role="status">
        <Spinner size="sm" />
        Waiting for ssh…
      </p>
    );
  }

  return (
    <AppDialog
      isOpen={state.phase !== "idle"}
      onClose={onClose}
      size="sm"
      zIndex="nested"
      initialFocus={prompt?.kind === "secret" ? "first" : "cancel"}
      focusResetKey={prompt?.id ?? state.phase}
      data-testid="ssh-sign-in-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Sign in to {hostLabel}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="space-y-3">
          <p className="text-xs text-text-secondary">
            Daintree shows you ssh&apos;s questions and hands your answers straight back to ssh. It
            keeps none of them.
          </p>
          {body}
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={primary}
        secondaryAction={{ label: state.phase === "failed" ? "Close" : "Cancel", onClick: onClose }}
      />
    </AppDialog>
  );
}
