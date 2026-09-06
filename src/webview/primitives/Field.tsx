import { ReactNode } from 'react';

interface Props {
  label: string;
  htmlFor?: string;
  /** Marks the field as one a connection cannot go without. */
  required?: boolean;
  hint?: ReactNode;
  /** Replaces the hint and turns the row red when set. */
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, children }: Props) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor}>
          {label}
          {required ? <span className="required" aria-hidden="true"> *</span> : null}
        </label>
      ) : (
        <span className="label">
          {label}
          {required ? <span className="required" aria-hidden="true"> *</span> : null}
        </span>
      )}
      {children}
      {error ? (
        <div className="hint bad" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  );
}
