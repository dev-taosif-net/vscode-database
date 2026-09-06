import { EnvironmentId, environmentMeta } from '../../types';
import { setField, useSelect, useUpdate } from '../state/editor';
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

/**
 * The standing warning on a production connection, and the one place that says
 * whether this connection can write.
 *
 * The banner above states what the environment means, which never changes. What
 * changes is this connection's own session mode, so it is stated here and
 * changed here. It was previously only reachable through Advanced, Security,
 * which is a poor place to keep the answer to "can this write to production".
 */
export function ProductionWarning() {
  const readOnly = useSelect((state) => state.draft?.readOnly ?? false);
  const update = useUpdate();

  return (
    <div className="prod-warning" role="note">
      <Codicon name="warning" className="glyph" />
      <div className="prod-body">
        <strong>Production environment</strong>
        <p>Changes here reach live systems. Connecting asks for confirmation first.</p>

        <div className={readOnly ? 'session-mode safe' : 'session-mode open'}>
          <Codicon name={readOnly ? 'lock' : 'unlock'} />
          <span className="mode-text">
            {readOnly ? (
              <>
                <strong>Sessions open read-only.</strong> Nothing you run can change data.
              </>
            ) : (
              <>
                <strong>Sessions open read-write.</strong> Statements you run reach live data.
              </>
            )}
          </span>
          <button
            type="button"
            className={readOnly ? 'btn ghost weakening' : 'btn outline'}
            onClick={() => update((state) => setField(state, 'readOnly', !readOnly))}
          >
            {readOnly ? 'Allow writes' : 'Make read-only'}
          </button>
        </div>
      </div>
    </div>
  );
}
