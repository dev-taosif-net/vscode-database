import { DriverKind } from '../../types';
import { PostgresLogo, SqlServerLogo } from './logos';

interface Props {
  driver: DriverKind;
  size?: number;
  /** Draws the mark on a tinted square, for a heading. */
  plate?: number;
}

/**
 * The engine's own mark, at whatever size the caller needs. Without `plate`
 * the glyph stands alone, which is what a list row wants.
 */
export function EngineMark({ driver, size = 16, plate }: Props) {
  const glyph = driver === 'mssql' ? <SqlServerLogo size={size} /> : <PostgresLogo size={size} />;

  if (plate === undefined) {
    return <span className="engine-glyph">{glyph}</span>;
  }

  return (
    <span className={`engine-plate eng-${driver}`} style={{ width: plate, height: plate }}>
      {glyph}
    </span>
  );
}

export function engineName(driver: DriverKind): string {
  return driver === 'mssql' ? 'Microsoft SQL Server' : 'PostgreSQL';
}
