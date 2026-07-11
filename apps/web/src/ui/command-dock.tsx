import { Ban, Send } from 'lucide-react';
import type { FormEvent } from 'react';

interface CommandDockProps {
  draft: string;
  busy: boolean;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function CommandDock({
  draft,
  busy,
  disabled,
  onDraftChange,
  onSubmit,
  onCancel,
}: CommandDockProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() && !disabled) onSubmit();
  };
  return (
    <form className="command-dock" onSubmit={submit}>
      <label className="sr-only" htmlFor="cat-command">Tell the cat what to do</label>
      <input
        id="cat-command"
        className="command-input"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="Ask the cat to explore, rest, or play..."
        disabled={disabled}
        maxLength={2_000}
        autoComplete="off"
      />
      {busy ? (
        <button className="icon-button cancel-button" type="button" onClick={onCancel} aria-label="Cancel current request" title="Cancel current request">
          <Ban aria-hidden="true" />
        </button>
      ) : (
        <button className="icon-button send-button" type="submit" disabled={disabled || !draft.trim()} aria-label="Send command" title="Send command">
          <Send aria-hidden="true" />
        </button>
      )}
    </form>
  );
}
