# Database Tools

Fast, lightweight Microsoft SQL Server and PostgreSQL tooling inside VS Code,
built for large enterprise estates: thousands of objects, many schemas, many
environments. Lazy loading everywhere, aggressive metadata caching, streamed
row-capped fetches, near-zero startup cost.

## Status: phase 2, the object explorer

Phase 1 covered everything up to and including an open connection. Phase 2
opens that connection up: every object in it, browsable and searchable. It
still does not run queries — the actions that need a result grid produce SQL in
an editor instead, and say so.

### The object explorer

A connected connection expands in place, in the same single-column sidebar. See
[docs/object-explorer.md](docs/object-explorer.md).

- Tables, views, procedures, functions, triggers, sequences, types and
  synonyms, each with its count read before a single row is.
- Two arrangements, saved per connection from its right-click menu: object
  types under the connection, or a schema level in between. Large estates want
  the second; the three service databases beside them do not.
- Tables and views open into their columns, with the primary and foreign keys
  marked; procedures and functions open into their parameters.
- Favourites: pin any object to the top of its connection.
- Search across every open connection at once, by name, schema or type.
  `sales.customer`, `proc:customer` and `sequences` all mean what they look
  like. What the panel already holds is fuzzy-matched on the keystroke; the
  servers are asked a moment later, so the answer is not limited to the folders
  you happened to have opened.
- Colourful marks with a distinct silhouette each, so the set survives a
  high-contrast theme, a forced palette and colour vision deficiency.
- Right-click an object for Open Definition, Select Top 100, Generate CRUD,
  Execute, Script As ALTER, Copy Name and Copy Full Name. Each opens an
  editable SQL document; nothing is executed yet.
- Five hundred objects at a time, cached for five minutes, nothing read until
  it is opened, and the whole subtree dropped the moment a session closes.

### Connections

- A connection editor in its own editor tab: identity down the left, the
  connection details beside it, a summary that never scrolls away, and a sticky
  action bar. Built in React against the workbench theme. See
  [docs/ui-architecture.md](docs/ui-architecture.md).
- A Connections view in the activity bar, listing every saved profile with a
  dot for its environment, filled when a session is open. It groups by
  environment, filters by name, host or database, and counts what it is showing.
  Clicking one opens the editor; the context menu connects, disconnects and
  deletes.
- A new connection opens straight into the editor and stays there. It reaches
  the list only when it is saved, so an abandoned draft leaves nothing behind.
- Paste a connection string, press Parse, and the server and sign-in fields
  fill in and open in front of you. ADO.NET, ODBC, libpq keyword and
  postgresql:// forms are all read, and the engine is recognised from the
  string itself.
- Transport, network, security, session and driver settings sit in five named
  groups, each closed until it is opened and each building nothing until then.
- The server address is checked as it is typed. The name is resolved and a
  socket is opened and closed without a word on it, so a typo is caught in a
  moment rather than thirty seconds into a driver timeout.
- Production asks before it connects, naming the server, the database and
  whether the session can write.
- Environments carry a colour everywhere they appear: the editor, the header,
  the status bar and the sidebar.
- SQL Server: Microsoft Entra ID (MFA, through the VS Code account provider),
  SQL Server logins, and Windows NTLM.
- PostgreSQL: SCRAM password, client certificate, and no-credential
  (trust or peer).
- Test connection, which opens a session, reports the round trip and closes it
  again, leaving nothing behind on the server.
- Failures translated into what the server said, what it means, and the safe
  fix as the first button.
- Read the database list from a live server.
- Environment guards for DEV, QA, UAT and PROD.
- Status bar showing the riskiest open connection.

## Trademarks

The Microsoft SQL Server and PostgreSQL marks in the connection editor identify
the products this extension connects to. SQL Server and Azure SQL are
trademarks of Microsoft; the elephant is a trademark of the PostgreSQL
Community Association of Canada. Neither owner endorses or sponsors this
extension. The artwork is bundled from Wikimedia Commons, published there as
public domain and under the BSD licence respectively; see
[src/webview/primitives/logos.tsx](src/webview/primitives/logos.tsx).

## Environments

| Environment | Colour | Behaviour |
| --- | --- | --- |
| DEV | Green | No extra guards. |
| QA | Blue | Destructive statements will ask for confirmation. |
| UAT | Orange | As QA, plus the environment name goes into the query history. |
| PROD | Red | Sessions open read-only, connecting asks for confirmation, and no credential is kept by default. |

The colours appear as a bar, a dot or a pill and never as a fill, and every one
of them is paired with a text label, so the meaning survives a monochrome
screen and colour vision deficiency.

## Credentials

- Secrets live in the VS Code secret store, which is the operating system
  keychain. Nothing secret is written to settings.json or to any file in the
  workspace.
- Settings Sync carries connection shapes between machines, never credentials.
- The connection string preview and every log line mask the secret.
- Deleting a connection deletes its secret in the same step.

## Commands

| Command | Keybinding |
| --- | --- |
| Database: Connections: Open | `Ctrl+Alt+D` |
| Database: Connections: New | |
| Database: Connect to a Database | |
| Database: Disconnect | |
| Database: Disconnect All | |
| Database: Refresh Objects | |

The object explorer's own actions are on the right-click menu of the row they
act on, so they are hidden from the palette, where there would be no row.

Inside the editor: `Ctrl+Enter` connects, `Ctrl+S` saves, `Alt+T` tests, and
`Escape` cancels a running attempt.

## Building

```
npm install
npm run build      # bundle to dist/
npm run watch      # rebuild on change
npm run typecheck
```

Press `F5` to launch a second VS Code window with the extension loaded.

`pg` and `tedious` are marked external in the bundle and are required lazily on
the first connection, so activation loads neither one.

## Not in this release

- Query execution and a result grid. Every explorer action that would need one
  writes its statement into an editor instead: Select Top 100, Generate CRUD
  and Execute produce SQL that is complete and correct for the object it came
  from, and you run it with whatever you already use. When the grid lands,
  Execute becomes a verb and none of that SQL has to change.

Designed and stored on the profile, but not yet acting:

- SSH tunnelling. The details are saved; connections still go direct.
- The read-only flag on SQL Server. PostgreSQL genuinely holds the session
  read-only through `default_transaction_read_only`; SQL Server has no session
  equivalent, so that flag waits for the query gate.
- Fully integrated Windows single sign-on, which needs a native driver.
  NTLM with an explicit domain, user and password works today.
