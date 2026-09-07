import { ReactNode, createContext, useContext, useMemo } from 'react';

export interface FieldAria {
  /** Mirrors the asterisk, for readers that cannot see it. */
  required?: boolean;
  /** The id of the hint or error that explains this control. */
  describedBy?: string;
}

const FieldAriaContext = createContext<FieldAria>({});

/**
 * What the surrounding `Field` knows about the control inside it.
 *
 * Passed down rather than handed to every input at every call site: the two
 * facts belong to the row, the controls are shared, and threading two more
 * props through fifteen call sites is fifteen chances to forget one.
 */
export function useFieldAria(): FieldAria {
  return useContext(FieldAriaContext);
}

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

/**
 * A labelled row.
 *
 * Required and optional are told apart by one asterisk after the label, and
 * that asterisk is `aria-hidden` because a screen reader announcing "star" is
 * noise. Which left the distinction visual only: every field sounded optional,
 * including the four a connection cannot be saved without. The marker stays
 * exactly as it looks, and the same fact is carried to assistive technology
 * through the control instead, where it belongs.
 *
 * The hint under a field has the same problem in reverse — it is the sentence
 * that explains what an empty box will do, and it was never tied to the box it
 * explains. `aria-describedby` needs an id to point at, so both the hint and
 * the error take one derived from the control's own.
 */
export function Field({ label, htmlFor, required, hint, error, children }: Props) {
  const describedBy = htmlFor && (error || hint) ? `${htmlFor}-hint` : undefined;
  const aria = useMemo<FieldAria>(() => ({ required, describedBy }), [required, describedBy]);

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
      <FieldAriaContext.Provider value={aria}>{children}</FieldAriaContext.Provider>
      {error ? (
        <div className="hint bad" id={describedBy} role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="hint" id={describedBy}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
