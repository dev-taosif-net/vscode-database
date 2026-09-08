import { DriverKind, ENVIRONMENTS, EnvironmentId, engineName, environmentMeta } from '../../types';
import { isNew, setField, useField, useProblem, useSelect, useUpdate } from '../state/editor';
import { Field } from '../primitives/Field';
import { SelectInput, TextInput } from '../primitives/Inputs';
import { EngineMark } from '../primitives/EngineMark';
import { IconSelect } from '../primitives/IconSelect';

/**
 * The left column: what this connection is, and nothing about how to reach it.
 * Everything here is metadata, so it stays put while the right column changes.
 *
 * Only the name carries a required mark. The other two are selects that
 * always hold a value, and an asterisk on a box that cannot be empty teaches
 * the eye to skip the asterisks that matter.
 */
export function IdentityPanel() {
  const environment = (useField('environment') ?? 'dev') as EnvironmentId;
  const driver = useField('driver') ?? 'mssql';
  const fresh = useSelect(isNew);
  const nameProblem = useProblem('name');
  const update = useUpdate();
  const meta = environmentMeta(environment);

  return (
    <aside className="identity" aria-label="Identity">
      <div className="identity-head">
        <EngineMark driver={driver} size={17} plate={30} />
        <div>
          <h2>Identity</h2>
          <p>Name, environment and engine</p>
        </div>
      </div>

      <div className="identity-body">
        <Field label="Connection name" htmlFor="f-name" required error={nameProblem}>
          <TextInput
            id="f-name"
            field="name"
            placeholder="Billing, production"
            invalid={Boolean(nameProblem)}
            autoFocus={fresh}
          />
        </Field>

        <Field label="Environment" htmlFor="f-env" hint={meta.guard}>
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

        <Field label="Server type" htmlFor="f-driver">
          <IconSelect
            id="f-driver"
            value={driver}
            options={[
              {
                value: 'mssql' as DriverKind,
                label: engineName('mssql'),
                detail: '2016 and newer, Azure SQL, Managed Instance, RDS',
                icon: <EngineMark driver="mssql" size={16} />
              },
              {
                value: 'postgres' as DriverKind,
                label: engineName('postgres'),
                detail: '12 and newer, Aurora, Cloud SQL, Neon, Supabase',
                icon: <EngineMark driver="postgres" size={16} />
              }
            ]}
            onChange={(next) => update((state) => setField(state, 'driver', next))}
          />
        </Field>
      </div>
    </aside>
  );
}
