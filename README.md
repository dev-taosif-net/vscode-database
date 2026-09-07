# Database Tools

Fast, lightweight Microsoft SQL Server and PostgreSQL tooling inside VS Code,
built for large enterprise estates: thousands of objects, many schemas, many
environments. Lazy loading everywhere, aggressive metadata caching, streamed
row-capped fetches, near-zero startup cost.

It is built on the workbench rather than beside it. SQL is written in VS Code's
own editor, the toolbar is a real editor title menu, IntelliSense is a real
completion provider, and every webview follows your theme and makes no network
request of any kind.

## Status: phase 3, the query workspace

Phase 1 covered everything up to and including an open connection. Phase 2
opened that connection up: every object in it, browsable and searchable. Phase
3 runs statements against it — a query editor bound to a connection, a result
grid that streams, a table data view, an execution form for a stored
procedure, object details with real dependency tracking, and execution plans
for both engines.

### The query workspace

See [docs/query-workspace.md](docs/query-workspace.md).

- SQL is written in the workbench's own editor, not in a bundled copy of one.
  Your vim mode, your Copilot, your find widget, your font settings and your
  keybindings all keep working, and a query tab costs what a text buffer costs.
- Run with F5 or Ctrl+Enter; a selection wins over the document. Results appear
  in one panel that follows whichever tab you are on, so a thousand tabs cost a
  thousand text buffers rather than a thousand iframes.
- Rows stream as the server produces them and stop at a fetch ceiling you can
  raise. Nothing collects a hundred million rows into an array: the host keeps
  a window and spills the rest to disk, and the grid holds only what it draws.
- A virtualised grid on both axes, with resizable and server-sortable columns,
  cell and range selection, copy as TSV, CSV, JSON, Markdown or INSERT
  statements, and export to CSV, TSV, JSON, SQL, Markdown or a real `.xlsx`
  with real dates in it.
- Sorting a query you wrote sorts only the rows that were fetched, and the
  header says so. A table data view sorts on the server and is exact.
- Cancel means cancel: SQL Server gets an attention signal on the request,
  PostgreSQL gets the protocol's own CancelRequest down a second socket, and
  the rows already fetched stay on screen.
- `Customer [Data]` opens a table without writing any SQL, paged by key rather
  than by offset — so page five thousand costs what page one costs. The row
  count in the corner is the estimate from statistics, never a `COUNT(*)`.
- `usp_GetCustomer [Run]` generates an execution form from the parameter list,
  with a NULL checkbox on every nullable parameter, values bound rather than
  concatenated, and output parameters and the return value in their own tabs.
- IntelliSense over the live catalog: schemas, objects, columns, aliases and
  keywords, ranked by what the caret is inside. After `ON`, the first
  suggestion is the whole foreign-key predicate.
- Object details with computed badges — PK, FK, Identity, Clustered, Heap,
  Temporal, Partitioned, Unlogged, Materialized — and Depends On / Used By from
  real dependency tracking. Where PostgreSQL cannot answer, the fallback is a
  text search and every row it finds is labelled as one.
- Execution plans for both engines, as an operator tree with cost shares, plus
  the three warnings that explain most bad plans.
- Query history per connection that keeps failures and redacts anything that
  set a credential, and saved queries as ordinary `.sql` files you can diff and
  review.
- A read-only connection refuses writes by name, and production asks again
  before anything is written — consenting to look at production is not
  consenting to change it.
- Execution runs on its own sessions, so a four-minute scan never freezes the
  explorer, the details panel or IntelliSense.

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
- Right-click an object for View Data, Select Top 100, Select Top 1000, Run…,
  Generate CRUD, Script As CREATE / ALTER / DROP, View Dependencies, Compare
  With, Show Details, Copy Name and Copy Full Name. Since phase 3 these end in
  rows rather than in a buffer.
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
| Database: New Query | |
| Database: Run | `F5`, `Ctrl+Enter` |
| Database: Run Current Statement | `Ctrl+Shift+Enter` |
| Database: Cancel | `Ctrl+Alt+.` |
| Database: Explain Plan | `Ctrl+L` |
| Database: Format SQL | `Shift+Alt+F` |
| Database: Connect to a Database | |
| Database: Disconnect | |
| Database: Disconnect All | |
| Database: Refresh Objects | |

The object explorer's own actions are on the right-click menu of the row they
act on, so they are hidden from the palette, where there would be no row. The
query actions appear on the editor title bar of any SQL tab bound to a
connection.

`Ctrl+Shift+F` also formats, but only while the caret is inside a bound SQL
editor. Everywhere else in the window it is still Search: Find in Files, which
is one of the six shortcuts everybody has in their fingers and not one worth
taking. `Shift+Alt+F` is the workbench's own format key and is bound
unconditionally, which is also what makes Format On Save work.

Inside the connection editor: `Ctrl+Enter` connects, `Ctrl+S` saves, `Alt+T`
tests, and `Escape` cancels a running attempt.

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

- **An editable grid.** The results grid is read-only and says so in its
  footer. Editing needs a unique key strategy, optimistic concurrency, a
  change set, a preview of the generated DML and a transaction model, and half
  of an editable grid against production is worse than none. Generate CRUD is
  how you get a statement you can read before you run it.
- **Schema comparison.** Compare With opens two scripted definitions in the
  workbench's own diff editor, which is genuinely useful and is a diff of two
  scripts rather than a comparison of two schemas. It says so.
- **PostgreSQL routine dependencies.** The server does not track what a
  PL/pgSQL body reads, so Used By falls back to a text search over source and
  labels every row it finds that way. A DBA about to drop a table needs to know
  both what the catalog knows and what it cannot.
- **Object created and modified dates on PostgreSQL.** The server does not
  record them anywhere. They show a dash and a tooltip saying why.
- **SSH tunnelling.** The details are saved on the profile; connections still
  go direct.
- **Fully integrated Windows single sign-on**, which needs a native driver.
  NTLM with an explicit domain, user and password works today.

The read-only flag now acts on both engines. PostgreSQL holds the session
read-only through `default_transaction_read_only`; SQL Server has no session
equivalent, so the batch is read before it is sent and a write is refused by
name — which is the gate the phase 1 comment said would arrive with execution.
