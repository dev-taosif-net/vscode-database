import { ENVIRONMENTS, EnvironmentId, environmentMeta } from '../../types';
import { isNew, useField, useSelect } from '../state/editor';
import { Field } from '../primitives/Field';
import { SelectInput, TextInput } from '../primitives/Inputs';
import { Codicon } from '../primitives/Codicon';

/**
 * The left column: what this connection is, and nothing about how to reach it.
 * Everything here is metadata, so it stays put while the right column changes.
 */
export function IdentityPanel() {
  const name = useField('name') ?? '';
  const environment = (useField('environment') ?? 'dev') as EnvironmentId;
  const driver = useField('driver') ?? 'mssql';
  const fresh = useSelect(isNew);
  const meta = environmentMeta(environment);

  return (
    <aside className="identity" aria-label="Identity">
      <div className="identity-head">
        <span className={`identity-mark eng-${driver}`}>
          <Codicon name="database" />
        </span>
        <div>
          <h2>Identity</h2>
          <p>Name, environment and engine</p>
        </div>
      </div>

      <div className="identity-body">
        <Field label="Connection name" htmlFor="f-name" required>
          <TextInput
            id="f-name"
            field="name"
            placeholder="Billing, production"
            invalid={!name.trim()}
            autoFocus={fresh}
          />
        </Field>

        <Field label="Environment" htmlFor="f-env" required hint={meta.guard}>
          <div className="row">
            <SelectInput
              id="f-env"
              field="environment"
              options={ENVIRONMENTS.map((option) => [option.id, option.label] as [EnvironmentId, string])}
            />
            <span className={`env-pill env-${environment}`}>
              <span className="dot" aria-hidden="true" />
              {meta.short}
            </span>
          </div>
        </Field>

        <Field label="Server type" htmlFor="f-driver" required>
          <SelectInput
            id="f-driver"
            field="driver"
            options={[
              ['mssql', 'Microsoft SQL Server'],
              ['postgres', 'PostgreSQL']
            ]}
          />
        </Field>
      </div>
    </aside>
  );
}
