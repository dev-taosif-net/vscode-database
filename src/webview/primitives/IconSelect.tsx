import { ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Codicon } from './Codicon';

export interface IconOption<T extends string> {
  value: T;
  label: string;
  /** A second line, for a choice that needs one. */
  detail?: string;
  icon: ReactNode;
}

interface Props<T extends string> {
  id: string;
  value: T;
  options: IconOption<T>[];
  onChange: (value: T) => void;
}

/**
 * A select that can show an icon beside each choice, which a native one cannot.
 *
 * It is the select-only combobox from the ARIA practices: focus stays on the
 * button, the open list is described through `aria-activedescendant`, and the
 * arrows, Home, End, Enter, Escape and type-ahead all behave the way they do in
 * a native dropdown. The list is rendered into the body and positioned fixed,
 * because the column it sits in clips its own overflow and a list opened near
 * the bottom of it would otherwise be cut in half.
 */
export function IconSelect<T extends string>({ id, value, options, onChange }: Props<T>) {
  const listId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const [rect, setRect] = useState<{ top: number; left: number; width: number; drop: boolean } | null>(null);

  const chosen = options.find((option) => option.value === value) ?? options[0];

  const place = useCallback(() => {
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor) {
      return;
    }
    // Roughly the list's height; enough to decide which way it should open.
    const wanted = options.length * 38 + 10;
    const below = window.innerHeight - anchor.bottom;
    const drop = below >= wanted || below >= anchor.top;
    setRect({
      top: drop ? anchor.bottom + 4 : anchor.top - 4,
      left: anchor.left,
      width: anchor.width,
      drop
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) {
      place();
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => setOpen(false);
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !list.current?.contains(target)) {
        setOpen(false);
      }
    };
    // A list positioned against the window has to go away when the window moves.
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) {
      onChange(option.value);
    }
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = options.findIndex((option) => option.value === value);
    const current = open ? active : Math.max(0, at);

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = Math.min(options.length - 1, Math.max(0, current + step));
        if (!open) {
          openAt(next);
        } else {
          setActive(next);
        }
        return;
      }
      case 'Home':
      case 'End':
        event.preventDefault();
        if (open) {
          setActive(event.key === 'Home' ? 0 : options.length - 1);
        } else {
          openAt(event.key === 'Home' ? 0 : options.length - 1);
        }
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) {
          commit(active);
        } else {
          openAt(current);
        }
        return;
      case 'Escape':
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
        return;
      case 'Tab':
        setOpen(false);
        return;
      default:
        break;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed.current.text = now - typed.current.at > 800 ? event.key : typed.current.text + event.key;
      typed.current.at = now;
      const needle = typed.current.text.toLowerCase();
      const found = options.findIndex((option) => option.label.toLowerCase().startsWith(needle));
      if (found >= 0) {
        event.preventDefault();
        if (open) {
          setActive(found);
        } else {
          onChange(options[found].value);
        }
      }
    }
  };

  return (
    <div className="picker">
      <button
        type="button"
        id={id}
        ref={button}
        className={open ? 'picker-button open' : 'picker-button'}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openAt(Math.max(0, options.findIndex((o) => o.value === value))))}
        onKeyDown={onKeyDown}
      >
        <span className="picker-icon">{chosen.icon}</span>
        <span className="picker-label">{chosen.label}</span>
        <Codicon name="chevron-down" className="caret" />
      </button>

      {open && rect
        ? createPortal(
            <ul
              ref={list}
              id={listId}
              role="listbox"
              aria-labelledby={id}
              tabIndex={-1}
              className="picker-list"
              style={{
                position: 'fixed',
                left: rect.left,
                width: rect.width,
                ...(rect.drop ? { top: rect.top } : { bottom: window.innerHeight - rect.top })
              }}
            >
              {options.map((option, index) => (
                <li
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={index === active ? 'picker-option active' : 'picker-option'}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(index)}
                >
                  <span className="picker-icon">{option.icon}</span>
                  <span className="picker-text">
                    <span className="picker-label">{option.label}</span>
                    {option.detail ? <span className="picker-detail">{option.detail}</span> : null}
                  </span>
                  {option.value === value ? <Codicon name="check" className="tick" /> : null}
                </li>
              ))}
            </ul>,
            document.body
          )
        : null}
    </div>
  );
}
