import { memo, useCallback } from 'react';
import { ConnectionProfile } from '../../types';
import { setField, useField, useUpdate } from '../state/editor';
import { Codicon } from './Codicon';
import { useFieldAria } from './Field';

type TextKey = {
  [K in keyof ConnectionProfile]: ConnectionProfile[K] extends string ? K : never;
}[keyof ConnectionProfile];

type NumberKey = {
  [K in keyof ConnectionProfile]: ConnectionProfile[K] extends number | null ? K : never;
}[keyof ConnectionProfile];

type BooleanKey = {
  [K in keyof ConnectionProfile]: ConnectionProfile[K] extends boolean ? K : never;
}[keyof ConnectionProfile];

/**
 * Every control below reads exactly one field out of the store, so typing in
 * one of them re-renders that control and the readings that quote it, and
 * nothing else on the page.
 */

interface TextProps {
  id: string;
  field: TextKey;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
}

export const TextInput = memo(function TextInput({
  id,
  field,
  placeholder,
  mono,
  invalid,
  ariaLabel,
  autoFocus
}: TextProps) {
  const value = useField(field) ?? '';
  const aria = useFieldAria();
  const update = useUpdate();
  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      update((state) => setField(state, field, next as ConnectionProfile[TextKey]));
    },
    [field, update]
  );

  return (
    <input
      id={id}
      type="text"
      className={mono ? 'mono' : undefined}
      value={String(value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-required={aria.required || undefined}
      aria-describedby={aria.describedBy}
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      onChange={onChange}
    />
  );
});

interface NumberProps {
  id: string;
  field: NumberKey;
  placeholder?: string;
  invalid?: boolean;
  ariaLabel?: string;
  width?: number;
}

export const NumberInput = memo(function NumberInput({
  id,
  field,
  placeholder,
  invalid,
  ariaLabel,
  width
}: NumberProps) {
  const value = useField(field);
  const aria = useFieldAria();
  const update = useUpdate();
  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      // An empty box stays empty; clearing one to retype it is the ordinary
      // way to change a number. What an empty box *means* is settled where the
      // profile is read, not here.
      const raw = event.target.value.trim();
      const next = raw === '' ? null : Number(raw);
      update((state) =>
        setField(state, field, (Number.isFinite(next) ? next : null) as ConnectionProfile[NumberKey])
      );
    },
    [field, update]
  );

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      style={width ? { width: `${width}px` } : undefined}
      value={value === null || value === undefined ? '' : String(value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-required={aria.required || undefined}
      aria-describedby={aria.describedBy}
      autoComplete="off"
      onChange={onChange}
    />
  );
});

interface SelectProps<K extends keyof ConnectionProfile> {
  id: string;
  field: K;
  options: [ConnectionProfile[K], string][];
  ariaLabel?: string;
}

export function SelectInput<K extends keyof ConnectionProfile>({
  id,
  field,
  options,
  ariaLabel
}: SelectProps<K>) {
  const value = useField(field);
  const aria = useFieldAria();
  const update = useUpdate();

  return (
    <div className="select">
      <select
        id={id}
        aria-label={ariaLabel}
        aria-required={aria.required || undefined}
        aria-describedby={aria.describedBy}
        value={String(value ?? '')}
        onChange={(event) => {
          const chosen = options.find(([option]) => String(option) === event.target.value);
          if (chosen) {
            update((state) => setField(state, field, chosen[0]));
          }
        }}
      >
        {options.map(([option, label]) => (
          <option key={String(option)} value={String(option)}>
            {label}
          </option>
        ))}
      </select>
      <Codicon name="chevron-down" className="caret" />
    </div>
  );
}

interface CheckProps {
  id: string;
  field: BooleanKey;
  label: string;
  hint?: string;
}

export const Checkbox = memo(function Checkbox({ id, field, label, hint }: CheckProps) {
  const value = useField(field);
  const update = useUpdate();

  return (
    <div className="check">
      <input
        id={id}
        type="checkbox"
        checked={Boolean(value)}
        onChange={(event) =>
          update((state) => setField(state, field, event.target.checked as ConnectionProfile[BooleanKey]))
        }
      />
      <label htmlFor={id}>
        {label}
        {hint ? <span className="check-hint">{hint}</span> : null}
      </label>
    </div>
  );
});
