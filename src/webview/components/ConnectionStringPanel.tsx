import { setMethod, useSelect, useUpdate } from '../state/editor';
import { defaultPortFor, parseConnectionString } from '../lib/connectionString';
import { Codicon } from '../primitives/Codicon';
import { Button } from '../primitives/Button';

/**
 * The other way of describing a connection. Parsing lays the string over the
 * draft and hands the editor back to the fields, which is where the result can
 * actually be read and corrected.
 */
export function ConnectionStringPanel() {
  const update = useUpdate();
  const text = useSelect((state) => state.parseText);
  const report = useSelect((state) => state.parseReport);

  const parse = () => {
    const parsed = parseConnectionString(text);
    if (!parsed) {
      update((state) => ({
        ...state,
        parseReport: {
          ok: false,
          text:
            'That does not read as a SQL Server or PostgreSQL connection string. Expected keys such as Server= and Initial Catalog=, or a postgresql:// address.'
        }
      }));
      return;
    }

    update((state) => {
      if (!state.draft) {
        return state;
      }
      const switched = parsed.patch.driver !== state.draft.driver;
      const patch = { ...parsed.patch };
      // A port carried over from the other engine would be wrong, and the
      // string did not mention one.
      if (switched && patch.port === undefined && patch.driver) {
        patch.port = defaultPortFor(patch.driver);
      }

      const draft = {
        ...state.draft,
        ...patch,
        properties: parsed.properties.length
          ? [...state.draft.properties, ...parsed.properties]
          : state.draft.properties
      };

      const filled = Object.keys(patch).filter((key) => key !== 'driver').length;
      const lines = [`Filled ${filled} ${filled === 1 ? 'field' : 'fields'} from a ${parsed.engine} string.`];
      if (switched) {
        lines.push(`The server type was switched to ${parsed.engine}.`);
      }
      if (parsed.secret !== undefined) {
        lines.push('The password went into the password box.');
      }
      if (parsed.properties.length) {
        lines.push(`Kept as driver properties: ${parsed.properties.map((p) => p.name).join(', ')}.`);
      }

      return setMethod(
        {
          ...state,
          draft,
          secret: parsed.secret !== undefined ? parsed.secret : state.secret,
          parseText: '',
          parseReport: { ok: true, text: lines.join(' ') }
        },
        'manual'
      );
    });
  };

  return (
    <div className="stack">
      <label className="label" htmlFor="f-parse">
        Paste a connection string
      </label>
      <textarea
        id="f-parse"
        className="mono"
        rows={4}
        spellCheck={false}
        value={text}
        placeholder={
          'Server=sql-dev-01.company.local,1433;Database=AdventureWorks;User Id=app;Password=…\npostgresql://app@db.example.com:5432/billing?sslmode=verify-full'
        }
        onChange={(event) => {
          const next = event.target.value;
          update((state) => ({ ...state, parseText: next }));
        }}
      />

      <div className="row">
        <Button tone="primary" icon="wand" disabled={!text.trim()} onClick={parse}>
          Parse
        </Button>
        {text ? (
          <Button
            tone="ghost"
            onClick={() => update((state) => ({ ...state, parseText: '', parseReport: null }))}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {report && !report.ok ? (
        <p className="note warn" role="alert">
          <Codicon name="warning" className="glyph" />
          <span>{report.text}</span>
        </p>
      ) : null}
    </div>
  );
}
