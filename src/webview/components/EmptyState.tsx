import { DriverKind } from '../../types';
import { post } from '../state/vscode';
import { Codicon } from '../primitives/Codicon';

const ENGINES: { driver: DriverKind; name: string; blurb: string }[] = [
  {
    driver: 'mssql',
    name: 'Microsoft SQL Server',
    blurb: '2016 and newer, Azure SQL Database, Managed Instance, and Amazon RDS.'
  },
  {
    driver: 'postgres',
    name: 'PostgreSQL',
    blurb: '12 and newer, plus Aurora, Cloud SQL, Neon, Supabase and Timescale.'
  }
];

export function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1>Connect to a database</h1>
        <p>
          Three fields get you connected. Encryption, timeouts and driver properties all have safe defaults
          and stay out of the way until you need them.
        </p>
        <div className="engine-cards">
          {ENGINES.map((engine) => (
            <button
              key={engine.driver}
              type="button"
              className="engine-card"
              onClick={() => post({ type: 'create', driver: engine.driver })}
            >
              <span className={`engine-mark eng-${engine.driver}`}>
                <Codicon name="database" />
              </span>
              <span className="engine-name">{engine.name}</span>
              <span className="engine-blurb">{engine.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
