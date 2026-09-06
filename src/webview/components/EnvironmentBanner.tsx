import { EnvironmentId, environmentMeta } from '../../types';
import { useSelect } from '../state/editor';
import { Codicon } from '../primitives/Codicon';

/**
 * The environment, said loudly.
 *
 * Colour alone would fail a monochrome screen and a good share of readers, so
 * every reading is repeated three ways: the badge text, the spelled-out name,
 * and the sentence naming the guard that is actually in force.
 */
export function EnvironmentBanner({ environment }: { environment: EnvironmentId }) {
  const meta = environmentMeta(environment);
  const production = environment === 'prod';

  return (
    <div className={`env-banner env-${environment}`} role="status" aria-live="polite">
      <span className="env-mark" aria-hidden="true">
        <Codicon name={production ? 'shield' : 'circle-filled'} />
      </span>
      <div className="env-names">
        <span className="env-short">{meta.short}</span>
        <span className="env-full">{meta.full}</span>
      </div>
      <span className="env-rule" aria-hidden="true" />
      <p className="env-guard">{meta.guard}</p>
    </div>
  );
}

/** The standing warning that a production connection is being written. */
export function ProductionWarning() {
  const readOnly = useSelect((state) => state.draft?.readOnly ?? false);
  return (
    <div className="prod-warning" role="note">
      <Codicon name="warning" className="glyph" />
      <div>
        <strong>Production environment</strong>
        <p>
          Changes here reach live systems. Sessions open {readOnly ? 'read-only' : 'read-write'}, and
          connecting asks for confirmation first.
        </p>
      </div>
    </div>
  );
}
