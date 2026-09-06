import { useRef } from 'react';
import { Codicon } from './Codicon';

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  /** Shown as a tooltip; the label alone must still be enough. */
  hint?: string;
}

interface Props<T extends string> {
  name: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
}

/**
 * A radio group wearing a segmented control. It is radios underneath, so a
 * screen reader announces "1 of 2" and the arrow keys move between them the
 * way they do anywhere else in the workbench.
 */
export function Segmented<T extends string>({ name, value, options, onChange }: Props<T>) {
  const group = useRef<HTMLDivElement>(null);

  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={name}
      ref={group}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (!step) {
          return;
        }
        event.preventDefault();
        const at = options.findIndex((option) => option.id === value);
        const next = options[(at + step + options.length) % options.length];
        onChange(next.id);
        group.current?.querySelector<HTMLButtonElement>(`[data-segment="${next.id}"]`)?.focus();
      }}
    >
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            data-segment={option.id}
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            className={chosen ? 'segment on' : 'segment'}
            title={option.hint}
            onClick={() => onChange(option.id)}
          >
            <Codicon name={chosen ? 'circle-filled' : 'circle-large-outline'} className="mark" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
