import { ReactNode } from 'react';
import { Codicon } from './Codicon';

export type ButtonTone = 'primary' | 'secondary' | 'outline' | 'success' | 'ghost' | 'danger';

interface Props {
  tone?: ButtonTone;
  icon?: string;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  hint?: string;
  onClick: () => void;
  children: ReactNode;
}

export function Button({ tone = 'secondary', icon, busy, disabled, title, hint, onClick, children }: Props) {
  return (
    <button
      type="button"
      className={`btn ${tone}`}
      disabled={disabled || busy}
      title={title}
      onClick={onClick}
    >
      {busy ? <Codicon name="loading" spin /> : icon ? <Codicon name={icon} /> : null}
      <span>{children}</span>
      {hint ? <kbd>{hint}</kbd> : null}
    </button>
  );
}
