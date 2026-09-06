import { ReactNode } from 'react';
import { Codicon } from './Codicon';

interface Props {
  icon: string;
  title: string;
  summary?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** A titled section of the editor. The heading is the only thing it insists on. */
export function Panel({ icon, title, summary, actions, children }: Props) {
  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-icon">
          <Codicon name={icon} />
        </span>
        <div className="panel-title">
          <h2>{title}</h2>
          {summary ? <p>{summary}</p> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
