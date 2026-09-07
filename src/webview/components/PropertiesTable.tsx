import { ConnectionProfile } from '../../types';
import { useSelect, useUpdate } from '../state/editor';
import { Codicon } from '../primitives/Codicon';

/** One shared empty list, so the no-draft reading keeps a stable identity. */
const EMPTY: ConnectionProfile['properties'] = [];

/** The driver key/value list. A pair with no name is dropped on save. */
export function PropertiesTable() {
  // `?? []` would be a fresh array on every read, which `useSyncExternalStore`
  // compares by identity and treats as a change that has to be redrawn again.
  const properties = useSelect((state) => state.draft?.properties) ?? EMPTY;
  const update = useUpdate();

  const edit = (index: number, part: 'name' | 'value', value: string) =>
    update((state) => {
      if (!state.draft) {
        return state;
      }
      const next = state.draft.properties.map((property, at) =>
        at === index ? { ...property, [part]: value } : property
      );
      return { ...state, draft: { ...state.draft, properties: next } };
    });

  const remove = (index: number) =>
    update((state) =>
      state.draft
        ? {
            ...state,
            draft: { ...state.draft, properties: state.draft.properties.filter((_, at) => at !== index) }
          }
        : state
    );

  const add = () =>
    update((state) =>
      state.draft
        ? { ...state, draft: { ...state.draft, properties: [...state.draft.properties, { name: '', value: '' }] } }
        : state
    );

  return (
    <div className="props">
      {properties.length ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {properties.map((property, index) => (
              <tr key={index}>
                <td>
                  <input
                    className="mono"
                    value={property.name}
                    aria-label={`Property ${index + 1} name`}
                    onChange={(event) => edit(index, 'name', event.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="mono"
                    value={property.value}
                    aria-label={`Property ${index + 1} value`}
                    onChange={(event) => edit(index, 'value', event.target.value)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${property.name || `property ${index + 1}`}`}
                    onClick={() => remove(index)}
                  >
                    <Codicon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Nothing set. The driver defaults apply.</p>
      )}
      <button type="button" className="link-btn" onClick={add}>
        <Codicon name="add" />
        Add a property
      </button>
    </div>
  );
}
