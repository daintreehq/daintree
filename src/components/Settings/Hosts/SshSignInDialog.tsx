import { useState } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Callout } from "@/components/ui/Callout";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/Spinner";
import type { SshSignInState } from "./useSshSignIn";

const PROMPT_TEXT_CLASS =
  "whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-primary select-text";

/**
 * ssh's own questions while it signs in to a host: a passphrase, a password,
 * a code, or a security key to touch. Each is shown as ssh wrote it; what is
 * typed goes to ssh and nowhere else.
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
  onAnswer: (promptId: string, text: string) => void;
  onRetry: () => void;
  /** Cancel a running sign-in, or put a failed one away. */
  onClose: () => void;
}) {
  // Keyed by the prompt it was typed for, so it never carries over to the next question.
  const [typed, setTyped] = useState<{ promptId: string; text: string } | null>(null);
  const prompt = state.phase === "signing-in" ? state.prompt : null;
  const text = prompt && typed?.promptId === prompt.id ? typed.text : "";
  const submit = () => {
    if (!prompt || prompt.kind !== "secret") return;
    setTyped(null);
    onAnswer(prompt.id, text);
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
  } else if (prompt) {
    body = (
      <div className="space-y-3">
        <pre className={PROMPT_TEXT_CLASS} data-testid="ssh-sign-in-prompt">
          {prompt.text}
        </pre>
        {prompt.kind === "secret" ? (
          <Field>
            <FieldLabel className="sr-only">Answer for ssh</FieldLabel>
            <Input
              key={prompt.id}
              type="password"
              value={text}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              data-testid="ssh-sign-in-answer"
              onChange={(event) => setTyped({ promptId: prompt.id, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
        ) : (
          <p className="flex items-center gap-2 text-sm text-text-secondary" role="status">
            <Spinner size="sm" />
            Waiting for ssh…
          </p>
        )}
      </div>
    );
    if (prompt.kind === "secret") primary = { label: "Continue", onClick: submit };
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
