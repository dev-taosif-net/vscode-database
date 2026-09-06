import { ReactNode } from 'react';
import { Codicon } from './Codicon';

interface Props {
  id: string;
  icon: string;
  title: string;
  summary: string;
  open: boolean;
  /** Shown on the closed row when the group holds something worth knowing. */
  badge?: ReactNode;
  onToggle: () => void;
  children: () => ReactNode;
}

/**
 * A collapsible group. The body is a function, so a closed group costs nothing
 * to render and its fields are never built until it is opened.
 */
export function Disclosure({ id, icon, title, summary, open, badge, onToggle, children }: Props) {
  return (
    <div className={open ? 'group open' : 'group'}>
      <button
        type="button"
        className="group-head"
        aria-expanded={open}
        aria-controls={`group-${id}`}
        id={`group-head-${id}`}
        onClick={onToggle}
      >
        <Codicon name="chevron-right" className="twist" />
        <Codicon name={icon} className="glyph" />
        <span className="name">{title}</span>
        <span className="group-summary">{summary}</span>
        {badge ? <span className="badge-slot">{badge}</span> : null}
      </button>
      {open ? (
        <div className="group-body" id={`group-${id}`} role="region" aria-labelledby={`group-head-${id}`}>
          {children()}
        </div>
      ) : null}
    </div>
  );
}
