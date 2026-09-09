# Query workspace architecture

Phase 3 gives the extension a verb. Phase 1 opened a connection, phase 2
browsed what was inside it, and every object action so far has ended in an
untitled SQL document with a note saying there is nowhere to put rows yet.
This is where the rows go.

It adds four things: a query editor bound to a connection, a result grid that
streams, a set of read-only surfaces over an object's metadata, and a form that
runs a stored procedure without anybody writing an `EXEC`. The explorer is
untouched — `docs/object-explorer.md` still describes it exactly, and nothing
below changes a row of it.

## The decision everything else follows from

There are two ways to build a query workspace inside VS Code and only one of
them is right.

The first is a webview holding Monaco: one iframe per tab containing an editor,
a toolbar, a grid and a status strip, laid out exactly as drawn. It is what a
mockup wants. It is also five megabytes of editor bundled beside an editor the
window already has, and it throws away everything the user has configured. Vim
mode is gone. Copilot is gone. The find widget is a different find widget with
different keys. Font ligatures, cursor style, word wrap, bracket colours,
`editor.tabSize` — all of it is now a second set of settings nobody asked for,
diverging from the first set on every workbench release. The tab does not
participate in Go Back, in breadcrumbs, in the timeline, or in split editors.
And `retainContextWhenHidden` on a Monaco webview is thirty megabytes a tab, so
"thousands of tabs" becomes a memory ceiling somewhere around forty.

The second is to write SQL in a real `TextDocument`, in the workbench's own
editor, and to put everything that is *not* text in webviews beside it. The
toolbar becomes an `editor/title` menu, which is a real toolbar with real
codicons and real `when` clauses. IntelliSense becomes a `CompletionItemProvider`,
which means it composes with every other SQL extension instead of replacing
them. The tab is a real tab: it splits, it pins, it drags to another group, it
survives a window reload, and it costs what a text buffer costs.

**Phase 3 takes the second.** Every SQL surface is a text document. Every
non-text surface — the grid, the plan, the details panel, the procedure form —
is a React webview that owns no state of its own.

The cost is honest and worth naming: the editor and its results are two
workbench surfaces rather than one drawn rectangle, so the "one workspace"
feeling has to be built out of layout and binding rather than out of a single
iframe. The rest of this document is largely about how.

## The layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⧉ Customer.sql   ×  │ usp_GetCustomer.sql │ Customer [Data] │ + │            │  real editor tabs
├──────────────────────────────────────────────────────────────────────────────┤
│ ▶ Run  ⚡ Plan  🧹 Format  ⋯          ● Dev-Matador · AdventureWorks  ▾       │  editor/title menu
├────────────────────────────────────────────────────────┬─────────────────────┤
│  1  SELECT TOP (100)                                   │ dbo.Customer        │  Details
│  2      c.CustomerId,                                  │ ─────────────────── │  (secondary
│  3      c.Name,                                        │ Table · dbo         │   side bar,
│  4      c.Email                                        │ ~12,430,121 rows    │   optional)
│  5  FROM dbo.Customer AS c                             │ 34 columns · 4.1 GB │
│  6  WHERE c.CreatedDate >= @since;                     │ PK  Clustered  FK×3 │
│     ▏                                                  │ Temporal            │
│                          the workbench's own editor    │ ─────────────────── │
│                                                        │ ▸ Columns       34  │
│                                                        │ ▸ Indexes        6  │
│                                                        │ ▸ Depends on     2  │
│                                                        │ ▸ Used by        7  │
├────────────────────────────────────────────────────────┴─────────────────────┤
│  Results   Messages   Plan                          ⌕ filter   ⭳ CSV  ⋯      │  panel area
│ ┌────┬────────────┬──────────────┬───────────────────────┬─────────────────┐ │  one webview,
│ │  # │ CustomerId │ Name         │ Email                 │ CreatedDate     │ │  follows the
│ ├────┼────────────┼──────────────┼───────────────────────┼─────────────────┤ │  active editor
│ │  1 │      10421 │ Adeyemi Ltd  │ ops@adeyemi.example   │ 2024-03-02 09:14│ │
│ │  2 │      10422 │ Braga & Co   │ hello@braga.example   │ 2024-03-02 09:41│ │
│ │  3 │      10423 │ Cheng Metals │ ap@chengmetals.exampl │ 2024-03-02 10:02│ │
│ └────┴────────────┴──────────────┴───────────────────────┴─────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● DEV  Dev-Matador · AdventureWorks   100 rows · 41 ms · streaming            │  status bar
└──────────────────────────────────────────────────────────────────────────────┘
```

Four regions, and each one is a workbench region rather than a div: the tab bar
is the editor group, the toolbar is the title menu, the details column is a
webview view the user can park in either side bar, and the results are a
webview view in the panel area where the terminal lives. The status bar entry
is the extension's existing one, widened.

Nothing here is a floating window and nothing here is modal. A person who
maximises the panel, hides the side bar, splits the editor down, or drags the
details view next to the explorer gets a workspace that still works, because
every part of it was already a part the workbench knows how to move.

### Why the results are one view and not one per tab

This is the load-bearing performance decision and it is worth stating plainly.

A webview is an iframe with its own renderer process share. Ten are fine. A
hundred are a laptop with the fans on. "Thousands of tabs" and "one webview per
tab" cannot both be true, so the grid is a single `WebviewView` in the panel
area that re-projects whenever the active editor changes — the same relationship
the Problems panel has with the editor, or the Debug Console with a session.

What makes that switch feel instant rather than like a reload is the state rule
below: the webview holds no result data of its own, so switching tabs is a
`project` message carrying a window of rows, not a re-execution and not a
re-mount. The host keeps the last eight result sets hydrated in memory and
spills the rest to disk; a tab you left an hour ago repaints from the spill file
in the time it takes to read a few hundred rows.

Two escape hatches, because the model has a real cost. **Pin results** detaches
a copy of the current grid into its own webview editor tab, for the person
comparing two answers side by side. And **Open results beside** puts the panel
view into the editor area for one query. Both are deliberate gestures with a
deliberate cost, rather than a cost everybody pays by default.

## Surfaces

| surface | what it is | tab or view |
|---|---|---|
| `Customer.sql` | text document, `dbquery:` scheme | editor tab |
| `usp_GetCustomer.sql` | text document, `dbquery:` | editor tab |
| Results / Messages / Plan | React webview | panel view, one |
| `Customer [Data]` | React webview | editor tab, one per table |
| `usp_GetCustomer [Run]` | React webview | editor tab, one per routine |
| Object details | React webview | side bar view, one |
| Query history | React webview | side bar view, one |
| Saved queries | tree over real files | side bar tree view |
| Dependencies | inside details, and a graph tab | view + optional tab |

Six of those are new views in the existing `databaseTools` container, and the
container gets a second group so Connections keeps the height it has.

## VS Code integration

### URI schemes

Every phase 3 surface is addressed by a URI, and the URI is the only identity
any of them has. There is no tab registry keyed by an integer.

```
dbquery://<profileId>/<name>.sql        a query editor bound to a connection
dbdata://<profileId>/<schema>.<name>    a table data grid
dbrun://<profileId>/<schema>.<name>     a procedure runner form
dbplan://<profileId>/<executionId>      a detached execution plan
dbobj://<profileId>/<kind>/<schema>.<name>   a scripted definition, read-only
```

The profile id is in the authority rather than in a side table, and that is
what makes binding survive everything: a window reload, a workspace reopen, a
tab dragged to another group, a `Reopen Closed Editor`. A `when` clause can
read it (`resourceScheme == dbquery`), a serializer gets it for free, and the
status bar can answer "which connection is this tab on" from the active editor
alone without asking anybody.

`dbquery:` documents are backed by a `FileSystemProvider` registered as
`isCaseSensitive` and non-readonly, with an in-memory backing store per
document. That is what makes them *editable and savable* — an untitled document
cannot carry an authority, and a `TextDocumentContentProvider` document is
read-only. Ctrl+S on a `dbquery:` document writes to the backing store and marks
the tab clean; Ctrl+Shift+S offers a real file, at which point the document
becomes an ordinary `.sql` file and keeps its binding through the binding map
below.

`dbobj:` is the one read-only scheme, served by a `TextDocumentContentProvider`,
because a scripted `CREATE` you are reading is not a draft. Phase 2's Open
Definition, which opens an untitled editable copy, keeps its behaviour and
moves to `dbquery:` so it can be run.

### Connection binding

A tab is bound to a connection, not to a session. Sessions come and go; the
binding outlives them.

For `dbquery:`, `dbdata:`, `dbrun:` the binding is the URI authority and needs
no storage. For a plain `.sql` file the user opened themselves — which must
work, because most SQL in a repository is in files — the binding lives in a
`Map<string, string>` from `uri.toString()` to profile id, persisted in
`workspaceState`. The status bar shows it; clicking the status bar changes it;
a file with no binding shows `Not connected` and Run offers a picker.

Changing a binding never re-runs anything and never closes a session. It
changes which pool the next execution asks.

### Database binding

A second binding sits beside the first: which *database* the tab is in. It is
separate because it moves for a different reason. The connection changes when
somebody decides to change it; the database changes whenever a `USE` goes past,
which on a migration script is several times a minute.

It is stored the same way — `uri.toString()` to database name, in
`workspaceState` — but for every scheme, including the ones whose connection
comes from the authority. A `dbquery:` tab can never be rebound to another
connection and can absolutely run `USE`.

Three things write it and one thing reads it:

- **The server.** SQL Server reports a database change as an ENVCHANGE token on
  the connection, which tedious surfaces as `databaseChange`. `SessionPool`
  subscribes per lease and re-publishes it as `onDidChangeDatabase`, and
  `extension.ts` writes it against the tab. Nothing parses SQL looking for the
  word `USE`: a scanner would miss the one inside a procedure, miss the one in
  an `IF` branch, and be wrong about the one whose statement failed.
- **The picker.** `databaseTools.selectDatabase` runs the same `USE` on the
  tab's own session, so the two routes cannot disagree.
- **The pool, on re-acquire.** An execution session is swept after fifteen idle
  minutes, and the next one opens in the profile's database. `acquire` re-issues
  the `USE`, which is what makes the database a property of the tab rather than
  of a socket that may no longer exist.

A move back to the profile's own database clears the binding rather than
storing it, so "this tab has moved" stays a fact the status bar can state.

Everything downstream reads the one value: the strip, the production write
confirmation, the execution record, and the metadata index.

For IntelliSense the consequence is a second catalog. `CatalogService`,
`MetadataIndex` and the foreign-key cache are keyed by connection *and*
database, and `ConnectionManager.scopedSession` opens one auxiliary session per
database anybody actually completes in. The control session never follows a
query tab: it is where the object explorer is drawn from, and a tree that moved
under the user would be a worse bug than a stale completion list.

`switchesDatabase(driver)` gates the whole feature. PostgreSQL binds a backend
to one database for its life, `\c` in psql is a client reconnecting, and doing
that silently here would hand back a session with none of the first one's temp
tables or open transaction. So the completion is not offered, the picker
refuses by name, and `useDatabase` rejects.

### The toolbar

`editor/title`, group `navigation`, gated on
`resourceScheme =~ /^dbquery$/ || databaseTools.boundSql`.

| action | icon | command | key |
|---|---|---|---|
| Run | `$(play)` | `databaseTools.run` | `F5`, `Ctrl+Enter` |
| Cancel | `$(debug-stop)` | `databaseTools.cancel` | `Alt+Break`, `Ctrl+Alt+.` |
| Explain plan | `$(type-hierarchy)` | `databaseTools.explain` | `Ctrl+L` |
| Format | `$(list-flat)` | `databaseTools.format` | `Shift+Alt+F`, `Ctrl+Shift+F`* |
| Change connection | `$(plug)` | `databaseTools.bind` | |
| Save query | `$(save-as)` | `databaseTools.saveQuery` | |
| Share | `$(export)` | `databaseTools.share` | |
| More | `$(ellipsis)` | submenu | |

Run and Cancel swap on `databaseTools.running` rather than sitting side by side,
because a stopped query does not need a stop button and a toolbar that changes
width as it runs is a toolbar that moves under the cursor.

*`Ctrl+Shift+F` is Search: Find in Files, one of the six shortcuts every VS Code
user has in their fingers. Rebinding it globally would be hostile. It is bound
here with `when: editorTextFocus && editorLangId == sql && databaseTools.boundSql`,
so it means Format only while the caret is inside a bound SQL editor and means
Find in Files everywhere else in the window, including in an unbound `.sql`
file. `Shift+Alt+F` — the workbench's own format key, which also drives Format
On Save — is bound unconditionally through the formatting provider, and is the
one documented first.

The More submenu carries: Run Current Statement (`Ctrl+Shift+Enter`), Run to
Grid / Run to Text / Run to File, Include Actual Plan, Include Client
Statistics, Open Results Beside, Pin Results, Disconnect Tab, Copy as Markdown.

### Language features

All registered against `{ language: 'sql' }` and all no-ops on a document with
no binding, so nothing degrades a SQL file belonging to another extension.

- **Completion.** Schemas, objects, columns, parameters, aliases, keywords and
  snippets, ranked by what the caret is inside. Detailed below.
- **Signature help.** A procedure's parameters as you type inside `EXEC` or
  `CALL`, with the active one highlighted and its type and default in the label.
- **Hover.** An object's kind, row estimate and column count; a column's type,
  nullability, default and key role.
- **Definition.** `F12` on `dbo.Customer` opens `dbobj:` with its scripted
  `CREATE`; on a procedure name, its body.
- **Formatting.** Document and range, engine-aware, no dependency. Detailed
  below.
- **Diagnostics.** Only what the server said. A failed execution maps its error
  to a range in the batch that produced it, so a syntax error underlines the
  line rather than living in a toast. Nothing is parsed for correctness ahead of
  execution — a client-side SQL validator that disagrees with the server is
  worse than none.
- **Semantic tokens.** Off by default. The built-in SQL grammar already colours
  keywords and strings, and a semantic layer that re-colours identifiers by
  whether they resolve is a per-keystroke catalog lookup for a colour.

### Status bar

The existing entry keeps its job — the riskiest open connection — and a second,
right-aligned entry appears only while a bound SQL editor or a data tab is
active:

```
███ Dev-Matador · 10.209.99.244 ███   $(database) PeopleDeskMatador   $(error) Failed
```

Connection and server in the environment hue, then the database, then the last
execution — but only in the two states you can still act on, running and
failed. While a query runs the third entry becomes `$(sync~spin) Executing…`
and is clickable to cancel.

The database is its own entry rather than a third part of the chip, because it
is the one of the three that changes without anybody deciding to change it —
see **Database binding**. Its click target runs the picker, and its tooltip
says where the tab came from when it has moved.

### Serialization

Every webview panel registers a `WebviewPanelSerializer`. Because a webview
holds no state, `deserializeWebviewPanel` needs nothing but the URI, which it
already has from the panel's own state: it re-mounts the React app, the app says
`ready`, and the host projects. A window reload restores forty data tabs for the
cost of forty empty iframes, hydrated one at a time as they are revealed.

## Tab management

```
                 ┌──────────────────────────────────────┐
   open gesture  │  WorkspaceRouter                     │
  ───────────────▶  uri = address(target)               │
                 │  if a tab holds uri → reveal it      │
                 │  else → open it                      │
                 └──────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        ▼                         ▼                          ▼
  TextDocument               WebviewPanel               WebviewView
  dbquery: dbobj:            dbdata: dbrun: dbplan:     results, details,
  (workbench owns it)        (LRU, disposable)          history
```

**One tab per address.** Opening `View Data` on `dbo.Customer` twice reveals the
first tab. Opening a *second* query editor is a different address, because a
query editor's name is generated (`Query 1.sql`, `Query 2.sql`) and two of them
are two different documents by construction.

**Preview tabs.** A single click in the explorer opens in preview (italic tab,
replaced by the next single click); a double click, or an edit, promotes it.
That is the workbench's own convention and it is the reason browsing forty
tables does not leave forty tabs. `preview: true` on `showTextDocument`, and
`ViewColumn.Active` so it lands where the user is looking.

**Webview tab budget.** Data and runner tabs are capped at sixteen live
webviews. Beyond that the least recently *visible* one is disposed — not closed:
its tab stays, and revealing it re-creates the webview from the host's state in
under a frame. `retainContextWhenHidden` is false everywhere in phase 3 for the
same reason. The connection editor keeps it, because it holds a draft; nothing
here holds anything.

**Closing.** Closing a query tab cancels its running execution and releases its
pool lease. It does not close the session — other tabs are on it. Disconnecting
a connection marks every tab bound to it as unbound rather than closing them,
because the SQL in them is the user's work.

## State management

One rule, and it is the same rule the sidebar already follows:

> The host owns state. A webview is a projection with a scroll position.

```
        extension host                                     webview
  ┌────────────────────────┐                        ┌──────────────────┐
  │ ConnectionStore        │                        │  createStore     │
  │ CatalogService         │──── project ──────────▶│  (selector       │
  │ SessionPool            │   window of rows,      │   subscription)  │
  │ ExecutionService       │   columns, status      │        │         │
  │ ResultStore  ──▶ spill │                        │   React tree     │
  │ HistoryStore           │◀─── request ───────────│   reads one      │
  │ SavedQueryStore        │   getRows, sort,       │   value each     │
  │ BindingStore           │   export, cancel       │                  │
  └────────────────────────┘                        └──────────────────┘
```

The store is `src/webview/state/store.ts`, unchanged — the fifty-line
subscribe-with-a-selector store the editor already uses, for the same reason it
exists there. A grid of forty visible rows across twelve columns is roughly five
hundred cells; with context, a single `getRows` answer re-renders all of them.
With selectors, a row subscribes to its own row and a column header to its own
width, so dragging a column boundary re-renders one header and the cells under
it.

Three things live in the webview and only three: scroll offset, column widths,
and the current selection rectangle. All three are per-tab and all three go
through `vscode.setState`, so they survive a webview being disposed under the
LRU and restored. Everything else — which result set is showing, the sort, the
filter, the row window — is host state, because all three of those change what
the host has to fetch.

### Host stores

| store | holds | persistence |
|---|---|---|
| `BindingStore` | uri → profile id | `workspaceState` |
| `ResultStore` | executions, columns, row buffers | memory + spill file |
| `HistoryStore` | per-connection query log | JSONL in global storage |
| `SavedQueryStore` | saved queries | real `.sql` files |
| `MetadataIndex` | completion index per connection | memory, from `CatalogService` |
| `TabState` | per-tab sort, filter, page | `workspaceState`, capped |

`SavedQueryStore` is files rather than a memento on purpose. A saved query is
something people diff, review, share in a pull request and lose when their
machine dies. Default location is `.database/queries/` in the first workspace
folder, configurable, falling back to global storage when there is no folder
open. Each file carries a two-line header comment naming the connection it was
written against, which is also how a saved query opened from disk arrives
pre-bound.

## Session pool and the execution pipeline

### Why a pool

Today a profile has exactly one session: one tedious `Connection`, one pg
`Client`. Both are strictly serial — one statement in flight at a time — and
that is fine for a catalog, where every statement is a bounded read that returns
in milliseconds.

It is not fine for phase 3. A `SELECT` scanning a hundred million rows would
hold the only session for four minutes, and during those four minutes expanding
a folder in the explorer would hang, the details panel would hang, and
IntelliSense would stop answering. Worse, cancelling it would have to cancel
through the same connection it is blocking.

So phase 3 splits a connection into a pool:

```
  profile "Dev-Matador"
  ┌──────────────────────────────────────────────────────────────┐
  │  control     ── catalog, metadata, completion, details       │  1, always
  │                 short statements only, never leased out      │
  │  exec #1     ── leased to Customer.sql                       │  0..N, lazy
  │  exec #2     ── leased to usp_GetCustomer.sql                │  idle-reaped
  │  side        ── cancel and pg_cancel_backend only            │  on demand
  └──────────────────────────────────────────────────────────────┘
```

- **Control** is the session `ConnectionManager` already opens. `CatalogService`
  keeps using it and never waits behind a user's query.
- **Exec** sessions are opened on first execution for a tab and leased for as
  long as that tab is running, then returned to the pool. Default ceiling is
  four per profile, configurable, because a DBA with a connection limit of ten
  should not find that one editor window ate it. A tab that wants a lease when
  the pool is full waits, and says so in the status bar rather than silently
  queueing.
- **Session-scoped state is why a lease is per tab and not per statement.** A
  temp table, a `SET` option, an open transaction and `@@IDENTITY` all belong to
  a session, and a user who creates `#staging` in one batch expects it in the
  next. Leases are sticky: a tab keeps the same exec session until it is closed,
  idle for fifteen minutes, or explicitly reset from `More ▸ New Session`.
- **Side** is a throwaway connection opened only to cancel, and only for
  PostgreSQL, which needs one.

### The pipeline

```
  text ──▶ split ──▶ per batch ──▶ execute ──▶ sink ──▶ ResultStore ──▶ project
           │                        │           │            │
           │                        │           │            └─ spill beyond 100k
           │                        │           └─ rows, columns, messages, errors
           │                        └─ streaming, cancellable
           └─ GO / statement boundaries, comment- and string-aware
```

**Split.** SQL Server batches on a line whose only content is `GO`, optionally
followed by a repeat count — that is a client convention, not T-SQL, and the
server rejects it. PostgreSQL has no batch separator, so the whole text is one
statement unless the user asked for Run Current Statement, in which case the
splitter finds statement boundaries. Both splitters are the same scanner with
different rules, and it is a real scanner rather than a regular expression,
because `;` inside `$$ … $$`, inside `'…''…'`, inside `"…"`, inside `[…]`,
inside `--` and inside nested `/* */` all have to not be a boundary. A splitter
that gets dollar-quoting wrong cuts a PL/pgSQL function in half and runs the
first half.

Every batch keeps its offset in the original document, which is what lets a
server error land on the right line.

**Execute.** One `ExecutionRequest` per Run, holding an ordered list of batches,
a lease, a cancellation token and a sink. Batches run in order and stop at the
first error unless `More ▸ Continue On Error` is on.

**Stream.** Both drivers already emit rows one at a time and neither is being
asked to do anything new.

- SQL Server: `request.on('row')` and `on('columnMetadata')` on the tedious
  `Request` the driver already builds. The existing `query()` helper collects
  into an array; phase 3 adds `stream()` beside it that hands each row to a sink
  instead. `on('done')` and `on('doneInProc')` carry row counts and
  `on('infoMessage')` carries `PRINT`, `RAISERROR` at low severity and
  `SET STATISTICS IO` output, which is what fills the Messages tab.
- PostgreSQL: `client.query(new Query(text, values))` returns a submittable that
  emits `row` and `end`. `notice` on the client carries `RAISE NOTICE`. For the
  Table Data view, where a hundred million rows are on the other side, a
  server-side cursor is used instead — `DECLARE … CURSOR WITHOUT HOLD` inside a
  transaction and `FETCH FORWARD n` — because a plain query streams rows the
  server has already committed to producing, and a cursor lets the grid stop
  asking.

**Cancel.** Different in each engine and neither is optional.

- SQL Server: `request.cancel()` on the tedious `Request`, which is more precise
  than `connection.cancel()` because it names the request rather than whatever
  the connection happens to be doing. The request's callback comes back with a
  cancellation error, which is mapped to `cancelled` rather than to a failure.
- PostgreSQL: node-postgres implements the protocol's own cancel — a second
  `Client` is opened and `cancel(activeClient, query)` sends a CancelRequest
  carrying the backend's process id and secret key, both of which the client
  captured at startup. That is the out-of-band path the protocol was designed
  for, and it needs no login and no permission on the target session, which
  `pg_cancel_backend` does. It is not in the published typings, so the pool
  declares it. `pg_cancel_backend` stays as the fallback for a server that
  refuses the CancelRequest, and if neither lands within two seconds the user is
  offered `pg_terminate_backend`, named as what it is: it kills the session and
  loses any open transaction.

A cancel is always followed by draining the sink and marking the result set
partial. Rows already delivered stay on screen and are labelled `cancelled after
41,208 rows`, because throwing away what was already fetched is the one thing a
person cancelling a long query never wants.

**Guards.** A statement against a connection marked read-only is checked before
it is sent: for PostgreSQL the session is already `default_transaction_read_only`,
and for SQL Server, which has no session switch, the batch is scanned for
mutating statements and refused with a named reason. Production keeps phase 1's
confirmation and gains a second one for anything that is not a `SELECT`.

### Memory

The number that matters: a hundred-million-row table must not be a
hundred-million-row array.

- Rows arrive as **arrays, not objects**. Column names are sent once, in the
  columns message. Thirty-four string keys per row across a million rows is
  thirty-four million strings that carry no information after the first row.
- The `ResultStore` keeps a **row window** per result set: the first 100,000
  rows in memory as an array of arrays, and everything beyond that appended to a
  spill file in `context.storageUri` as length-prefixed JSON lines with a sparse
  offset index every thousand rows. Seeking to row 4,000,000 is a seek to the
  nearest index entry and a short scan.
- The webview holds **only the visible window plus overscan** — typically 60 to
  200 rows. It asks for `getRows(offset, count)` as it scrolls and forgets what
  scrolls away. A grid showing forty rows of a forty-million-row answer holds
  forty rows.
- **Fetch ceiling.** Execution stops at `databaseTools.rowsPerFetch` — the
  setting that already exists, default 1000 for a query editor — and shows
  `Fetched 1,000 of many. Fetch more ▾`. That is not a limitation to apologise
  for; it is the difference between clicking Run on `SELECT * FROM Orders` and
  losing the window.
- Every result set is disposed with its tab, and the spill file with it. The
  storage directory is swept on activation for files from a window that crashed.

### The extension host is never blocked

The host is single-threaded and shares its thread with every other extension in
the window. Three things in phase 3 are big enough to matter and all three go to
a `node:worker_threads` worker:

| work | why it moves |
|---|---|
| Execution plan XML → tree | a plan for a fifty-join query is megabytes of XML |
| CSV / TSV / XLSX export | a million rows of string formatting and deflate |
| Spill file index rebuild | only on recovery, but it is a full scan |

Everything else is I/O-bound and stays on the host. Row streaming does not move:
it is a socket callback that pushes into an array, and moving it to a worker
would mean copying every row across a thread boundary to save nothing.

## Results grid architecture

No grid dependency. The requirements — virtualised on both axes, resizable,
themed by workbench tokens, streaming from a host over `postMessage` — are
specific enough that every library would be fought rather than used, and the
grid is about six hundred lines.

```
  ResultsPanel
  ├── ResultsToolbar        tabs, filter, export, row count, elapsed
  ├── ResultTabs            one per result set when a batch returned several
  ├── Grid
  │   ├── HeaderRow         sticky, sortable, resizable, column virtualised
  │   ├── Viewport          the scroll container, one element
  │   │   └── Canvas        height = rows × 22, absolutely positioned
  │   │       └── Row ×n    only the visible window
  │   ├── SelectionLayer    the marching rectangle, one element
  │   └── ColumnResizer     a drag handle per visible boundary
  ├── MessagesPane
  └── PlanPane
```

**Virtualisation is two-dimensional.** Rows, obviously. Columns too, because a
`SELECT *` on a wide fact table is two hundred columns and rendering two hundred
cells per row for forty rows is eight thousand elements to show the twelve a
person can see. Only columns intersecting the horizontal viewport are rendered,
with the row-number column pinned.

**Row height is fixed at 22px**, `list.rowHeight`, the same value the explorer
uses. Fixed height is what makes `scrollTop / 22` an index rather than a
measurement, and it is what makes jumping to row nine million a subtraction.
Variable-height rows would buy wrapped text and cost the whole scroll model; a
long value gets a tooltip and a detail pane instead.

**Column widths** are measured once from the first two hundred rows, per column
type: a `bit` gets 60px, a `datetime2` gets the width of a rendered timestamp, an
`nvarchar(max)` gets a sensible cap. Measured with an offscreen canvas
`measureText` rather than by rendering, which is one paint instead of a
thousand. The user's drag wins forever after and is remembered per tab.

**Sorting is the honest part.** A grid holding a window over a streamed answer
cannot sort the answer by sorting what it holds — sorting 1,000 fetched rows of a
40-million-row result and presenting it as sorted is a lie that has shipped in
several tools. So:

- If the result came from a **Table Data view**, sorting re-issues the query with
  `ORDER BY`, server-side, and the grid resets to the top. Correct and fast.
- If the result came from a **query the user wrote**, the grid sorts only the
  rows it has fetched, and the header says so: `sorted within 1,000 fetched rows`.
  Offered because it is genuinely useful on a small result and labelled because it
  is wrong on a large one.
- Sorting is never offered while a query is still streaming.

**Selection and copy.** Cell, range, row, column, and Ctrl+A. Copy gives TSV,
which is what pastes into Excel as columns; Copy with Headers adds a header row;
Copy as INSERT, as JSON, as Markdown live under the right-click menu. A copy of a
selection extending past the fetched window fetches the missing rows first,
through the host, with a progress notification when it is large.

**Filter within results** filters the fetched window immediately, then offers
`Search the server instead` which converts the text into a `WHERE` for a Table
Data view or a `HAVING`-free wrapper for a user query. Immediate and local first,
because that is the case ninety percent of the time and it must not wait on a
round trip.

**Export** never passes through the webview. The webview posts
`export { executionId, format, scope }`, the host streams from its buffer and its
spill file into a `showSaveDialog` target with a progress notification, and the
webview is told when it lands. Exporting four million rows through
`postMessage` would serialise the whole thing into a string first.

- **CSV / TSV**: RFC 4180 quoting, `﻿` BOM optional for Excel, configurable
  delimiter, null rendered as empty or as a chosen token.
- **XLSX**: written directly — a zip with `node:zlib` deflate, `xl/worksheets/`
  as streamed XML with a shared string table capped and spilling to inline
  strings. No dependency. Real dates, real numbers, a frozen header row and an
  autofilter, because an export that turns `2024-03-02` into a string is an
  export somebody has to fix by hand.
- **JSON / SQL INSERT / Markdown**: same path, different formatter.

**Null and value rendering.** `NULL` in italic dim, distinct from an empty
string, which renders as nothing but selects as nothing — the two are told apart
by a hairline. Binary is `0x…` truncated with a byte count. `geography`,
`geometry`, `xml` and `jsonb` render as a one-line summary with a detail pane
behind Enter. Numbers are right-aligned and tabular; text is left-aligned; dates
are ISO-8601 in the server's own values, never localised, because a grid that
localises a `datetime2` is a grid whose CSV does not round-trip.

## Table data view

`Customer [Data]` — the answer to "I just want to look at the table", which is
the single most common thing anybody does in a database tool.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🟦 dbo.Customer      ⌕ filter…       CreatedDate ↓    ⟳   ⭳   ~12,430,121    │
├──────────────────────────────────────────────────────────────────────────────┤
│  grid, identical component, keyset-paged                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ rows 1–200 of ~12,430,121 · 34 ms · read-only          ‹ ›  200 ▾            │
└──────────────────────────────────────────────────────────────────────────────┘
```

It is the same grid with a different data source, and the difference is the
source is a *table*, which means three things are possible that are not possible
over an arbitrary query: sorting is server-side, filtering is a `WHERE`, and
paging is **keyset** rather than `OFFSET`.

Keyset matters at the sizes this is built for. `OFFSET 9000000 ROWS FETCH NEXT
200` makes the server walk nine million rows to throw them away; every page is
slower than the last, and page five thousand takes a minute. Keyset paging
carries the last row's key and asks for `WHERE (key) > (last)`, which is an index
seek at any depth. So:

- If the table has a single-column or composite key the sort can be extended
  with, paging is keyset and constant-time at any offset.
- If it has none — a heap with no unique index, sorted by a non-unique column —
  paging falls back to `OFFSET`, the footer says `slower past page 50`, and the
  Jump to row box is disabled rather than silently taking a minute.

The row count in the corner is the **estimate**, from
`sys.dm_db_partition_stats` or `pg_class.reltuples`, prefixed with `~` and with
`count exactly` behind a click. Never `COUNT(*)` on open. A tool that runs
`SELECT COUNT(*)` to fill a label is a tool that takes forty seconds to show an
empty grid on the table that most needs looking at.

`Select Top 100` and `Select Top 1000` keep their phase 2 meaning and now
*execute* rather than scaffold: they open a `dbquery:` tab with the statement
already in it and run it. `View Data` opens this instead, because it is not a
statement — it is a table, with paging and sorting that a statement cannot have.

Editing is explicitly **out of scope for phase 3**. An editable grid needs a
unique key strategy, optimistic concurrency, a change set, a preview of the
generated DML and a transaction model, and half of an editable grid against
production is worse than none. The grid is read-only, says so in its footer, and
`Generate CRUD` is how you get a statement you can read before you run it.

## Object details panel

A webview view, default position in the primary side bar under Connections, and
`Open Details in Secondary Side Bar` moves it right for the layout in the
sketch. It follows the explorer's selection and the active tab's object, in that
order.

```
┌─────────────────────────────────┐
│ 🟦 dbo.Customer                 │
│ Table · SQL Server · Dev-Matador│
├─────────────────────────────────┤
│  PK  Clustered  FK×3  Identity  │   tags
│  Temporal  Partitioned          │
├─────────────────────────────────┤
│ Rows        ~12,430,121         │
│ Columns     34                  │
│ Data        3.8 GB              │
│ Indexes     6 · 412 MB          │
│ Created     2022-01-05          │
│ Modified    2025-02-12          │
├─────────────────────────────────┤
│ ▶ View Data      ⚙ Generate CRUD│   quick actions
│ ⧉ Script CREATE  ⧉ Script ALTER │
│ ⇄ Dependencies   ⇋ Compare      │
├─────────────────────────────────┤
│ ▾ Columns                    34 │
│   🔑 CustomerId   int  identity │
│      Name         nvarchar(200) │
│      Email        nvarchar(320) │
│ ▸ Indexes                     6 │
│ ▸ Foreign keys                3 │
│ ▸ Triggers                    2 │
│ ▸ Depends on                  2 │
│ ▸ Used by                     7 │
└─────────────────────────────────┘
```

Every section is lazy. Opening the panel costs one statement — the header block
and the tags. Columns cost a second one, and it is the one `CatalogService`
already caches from the explorer, so expanding a table in the tree and then
opening details is one round trip, not two.

### The tags

Badges are computed, never guessed, and every one of them is a fact with a
statement behind it.

| tag | SQL Server | PostgreSQL |
|---|---|---|
| PK | `sys.key_constraints`, type `PK` | `pg_constraint.contype = 'p'` |
| FK | `sys.foreign_keys` count | `contype = 'f'` |
| Identity | `sys.identity_columns` | `attidentity` (10+) or `serial` default |
| Clustered | `sys.indexes.type = 1` | — (Postgres has no clustered index; `CLUSTER`ed shows as `Clustered on <index>` from `pg_index.indisclustered`) |
| Trigger | `sys.triggers` count | `pg_trigger`, excluding internal |
| Temporal | `sys.tables.temporal_type = 2` | — |
| Partitioned | `sys.indexes.data_space_id` → `sys.partition_schemes` | `pg_class.relispartition` / `relkind = 'p'` |
| Heap | `sys.indexes.type = 0` | — |
| Unlogged | — | `pg_class.relpersistence = 'u'` |
| Materialized | — | `relkind = 'm'` |

An engine without a concept does not get a greyed badge for it; it gets no
badge. A dash where a fact does not exist — PostgreSQL genuinely does not record
when a table was created, and `Created —` with a tooltip saying so is the
truthful rendering. Guessing from a file timestamp would be worse than blank.

Badge colours reuse the object hue system and each badge carries a letterform,
so the set survives a high-contrast theme exactly as the object marks do.

## Procedure runner

Opening a procedure gives its definition, as it always has. `Run…` on it gives
this.

```
┌──────────────────────────────────────────────────────────────┐
│ 🟪 dbo.usp_GetCustomer            ● Dev-Matador · AdventureW.│
├──────────────────────────────────────────────────────────────┤
│  Customer Id            required, int                        │
│  ┌────────────────────┐                                      │
│  │ 10421              │                                      │
│  └────────────────────┘                                      │
│                                                              │
│  Include Orders         bit · default 0                      │
│  [✓]                                                         │
│                                                              │
│  As Of Date             datetime2 · nullable                 │
│  ┌────────────────────┐  ☐ NULL                              │
│  │ 2025-02-12 00:00   │                                      │
│  └────────────────────┘                                      │
├──────────────────────────────────────────────────────────────┤
│  ▸ Preview the statement                                     │
│                                            [ ▶ Execute  F5 ] │
├──────────────────────────────────────────────────────────────┤
│  Results ▾   Messages   Output parameters   Return value     │
│  the same grid                                               │
└──────────────────────────────────────────────────────────────┘
```

The form is generated from the parameter list `CatalogService.members` already
returns, and the control is chosen by type: a checkbox for `bit`/`boolean`, a
number field with the type's range for integers and decimals, a date field for
temporal types, a combo for a parameter whose only check constraint is an
`IN` list, and a text area for `nvarchar(max)`. Nullable parameters get a NULL
checkbox that disables the field, because empty string and NULL are different
arguments and a form that cannot express the difference cannot call the
procedure.

Parameters with defaults are pre-filled with the default and marked, so pressing
Execute without touching anything does what calling the procedure with no
arguments does.

**Preview the statement** is closed by default and shows the exact `EXEC` or
`CALL` that will be sent, with the values bound — not interpolated, and the
preview says so. It is there for the two things people actually want: pasting
the call into a ticket, and confirming what a form is about to do to production.

Values are bound as parameters, never concatenated. Output parameters and the
return value come back as their own tabs, because a procedure that returns a
result set *and* an output parameter is common and a runner that shows only the
grid loses half the answer.

Arguments are remembered per procedure per connection, in `workspaceState`, so
the second run is one click. They are not remembered across connections: the
customer id that exists in DEV does not exist in PROD, and a form that
helpfully pre-fills a production run with a development id is a form that will
eventually be part of an incident.

## Dependency architecture

Every object exposes two lists, and they are not the same query in two
directions.

```
   Depends on                    dbo.Customer                    Used by
   ─────────────                 ────────────                    ───────
   dbo.Region      (FK)                                 vw_CustomerSummary  (view)
   dbo.fn_Slug     (computed col)                       usp_GetCustomer     (proc)
                                                        usp_UpdateCustomer  (proc)
                                                        trg_Customer_Audit  (trigger)
                                                        FK_Order_Customer   (FK, dbo.Order)
```

**SQL Server** has real dependency tracking. `sys.sql_expression_dependencies`
gives both directions for expression-level references, and
`sys.dm_sql_referencing_entities` / `sys.dm_sql_referenced_entities` resolve the
schema-bound and late-bound cases the catalog view leaves ambiguous. Foreign keys
come from `sys.foreign_keys` separately, because a foreign key is a dependency
people mean and is not an expression dependency. Cross-database and cross-server
references come back unresolved by design, and are shown as such rather than
dropped.

**PostgreSQL** is partial, and the honesty about that is the design.
`pg_depend` joined through `pg_rewrite` gives view and materialized-view
dependencies exactly, and `pg_constraint` gives foreign keys exactly. Function
and procedure bodies are *not tracked*: to the server a PL/pgSQL body is an
opaque string, so a procedure that reads `customer` creates no dependency row.
The only exceptions are SQL-standard bodies (`BEGIN ATOMIC`, PostgreSQL 14+),
which are parsed and do register.

Rather than showing an empty Used By and letting people conclude nothing uses
their table, the PostgreSQL reader falls back to a **text search** across
`pg_proc.prosrc` for the object's name, and labels every result it finds that
way as `matched in source` in a dimmer style with a footnote. It is a grep, it
can produce a false positive on a name that appears in a comment, and saying so
is the whole point. A DBA about to drop a table needs to know both what the
catalog knows and what it cannot know.

Dependencies are computed on demand and cached with the same five-minute TTL
`CatalogService` already uses, invalidated by the same events. The details panel
shows one level. `View Dependencies` opens a `dbdeps:` tab with the transitive
graph — an indented tree by default, since a tree is readable and a
force-directed blob is not, with cycle detection that marks a repeat rather than
recursing.

## Query history

Per connection, appended on every execution, kept in a JSONL file per profile in
global storage with a rolling cap.

```
┌─────────────────────────────────┐
│ ⌕ history…              Dev ▾   │
├─────────────────────────────────┤
│ ✓ 09:41  41 ms   100 rows       │
│   SELECT TOP (100) c.CustomerId,│
│   c.Name, c.Email FROM dbo.Cus… │
├─────────────────────────────────┤
│ ✓ 09:38  1.2 s   1 row          │
│   EXEC dbo.usp_GetCustomer @Cus…│
├─────────────────────────────────┤
│ ✗ 09:36  —       Invalid column │
│   SELECT * FROM Orders WHERE Cu…│
└─────────────────────────────────┘
```

Each entry stores the SQL text, the connection, when it started, how long it
took, how many rows came back or which error stopped it, and whether it was
cancelled. Clicking opens it in a new query tab bound to the same connection.
Right-click copies it, saves it as a saved query, or deletes it.

Two rules that are not obvious. **A failed query is kept**, prominently, because
the thing people most want out of history is the query they broke twenty minutes
ago. And **nothing that looks like a credential is stored**: statements matching
`CREATE LOGIN`, `ALTER LOGIN`, `CREATE USER … PASSWORD`, `PASSWORD =` and
`IDENTIFIED BY` are recorded as a redacted placeholder with their timing intact.
A history file is a plain file on disk that gets backed up, synced, and
occasionally pasted into a support ticket.

History is capped at 1,000 entries or 8 MB per connection, whichever comes
first, trimmed oldest-first on write. `Clear History` is on the view's title
menu and asks first.

## Saved queries

Files. `.database/queries/Customer Search.sql`, with a header:

```sql
-- @connection Dev-Matador
-- @description Customers created in the last 30 days, with order counts
SELECT …
```

The view is a tree over that folder, grouped by connection from the header and
falling back to folder structure. Saving from a query tab writes the file and
rebinds the tab to it, so the tab is now an ordinary `.sql` file that happens to
be bound — which means everything the workbench does to files works on it:
source control decoration, search, compare, rename.

`Share` on the toolbar is deliberately local and offers four things: copy the
SQL, copy the SQL with the connection header, copy the results as Markdown, and
reveal the saved file. There is no upload. The extension has never made a
network request and the content security policy in every webview forbids one;
adding a share target would be the first, and it would be the first time a
user's production SQL left their machine because they clicked a button on a
toolbar.

## Object scripting

Phase 2's scripting commands stay, gain the two that were missing, and gain a
result.

| object | commands |
|---|---|
| table | View Data · Select Top 100 · Select Top 1000 · Script CREATE · Script ALTER · Script DROP · Script SELECT / INSERT / UPDATE / DELETE · Generate CRUD · Copy Name · Copy Full Name |
| view | View Data · Script CREATE · ALTER · DROP · Open Definition |
| procedure | Run… · Execute · Script CREATE · ALTER · DROP · Open Definition |
| function | Run… · Script CREATE · ALTER · DROP · Open Definition |
| trigger, sequence, type, synonym | Script CREATE · DROP · Open Definition |

Script CREATE for a table is *composed*, because neither engine will hand you
one: columns with their types, nullability, defaults and identity, then the
primary key, then unique constraints, then check constraints, then foreign keys,
then indexes, in an order that actually replays. That composition already exists
in `catalog/script.ts` for `Generate CRUD` and is extended rather than
duplicated.

Script DROP always emits the guarded form — `IF OBJECT_ID(…) IS NOT NULL DROP …`
and `DROP … IF EXISTS` — and opens it in an editor rather than running it. There
is no command in phase 3 that drops anything without a human pressing Run on a
statement they can read.

## Execution plans

```
  Results   Messages   Plan
 ┌──────────────────────────────────────────────────────────────┐
 │  Graphical    Raw    Statistics                              │
 ├──────────────────────────────────────────────────────────────┤
 │   SELECT ──── Nested Loops ──┬── Index Seek  PK_Customer     │
 │    0%          12%           │    4%    12,430 rows          │
 │                              └── Key Lookup  IX_Customer_Em… │
 │                                   84%   ⚠ 12,430 executions  │
 └──────────────────────────────────────────────────────────────┘
```

- **SQL Server.** Estimated via `SET SHOWPLAN_XML ON`, which must be the only
  statement in its batch and returns a plan instead of rows. Actual via
  `SET STATISTICS XML ON`, which returns the rows *and* the plan as an extra
  result set. Both produce showplan XML, parsed in the worker into an operator
  tree with cost, estimated and actual row counts, and warnings.
- **PostgreSQL.** `EXPLAIN (FORMAT JSON)` for estimated,
  `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` for actual — and actual
  *runs the statement*, which for anything that writes is not what the user
  meant. So an `ANALYZE` on a non-`SELECT` is wrapped in a transaction that is
  rolled back, and the confirmation says exactly that before it runs.

One internal plan model, two readers, the same relationship `mssql.ts` and
`postgres.ts` already have in `catalog/`. The tree is rendered as a horizontal
operator tree with the expensive path highlighted, cost as a share of total,
node detail on selection, and three warnings called out because they are the
three that explain most bad plans: a large estimate-versus-actual divergence, a
scan where an index exists, and a spill to tempdb or disk.

The Raw tab is the XML or JSON, formatted, copyable — because the person who
needs to paste a plan into a ticket or into a plan analyser needs the raw one.
Statistics is the client statistics and `SET STATISTICS IO/TIME` output as a
table.

## Performance budget

| thing | budget | how |
|---|---|---|
| open a query tab | < 50 ms | a text document, nothing else |
| first row on screen | < 200 ms after the server's first row | streamed, projected in chunks of 200 |
| scroll to row 4,000,000 | < 100 ms | fixed row height, spill index |
| switch between tabs | < 50 ms | project, no re-execution |
| type a character in the editor | 0 extra ms | the workbench's editor, untouched |
| completion appears | < 80 ms | in-memory index, no round trip |
| 1,000 tabs open | < 200 MB | text buffers; ≤ 16 live webviews |
| explorer stays responsive during a 4-minute query | always | control session is never leased |

The one that is easiest to lose is the last, and it is the reason the pool
exists.

## Visual design

The workspace inherits the workbench theme. That is not a compromise, it is what
"native to VS Code" means: a person on Solarized Light who opens a query tab and
gets a dark grid has been handed a screenshot of another product. Every neutral
surface reads a `--vscode-*` token exactly as the two existing webviews do, and
`docs/ui-architecture.md` covers why.

The brief asks for a modern dark look, so the extension ships one: **Database
Tools Dark**, a contributed colour theme, near-black grounds, one accent, and
the object hues from `tokens.css` as its chart and syntax colours. Choosing it
makes the whole window look like the sketch — editor, grid, sidebar, tabs —
rather than making one panel disagree with the window around it. That is the
difference between a theme and a hardcoded palette.

Density follows the explorer: 22px rows, the same `--indent`, the same tabular
figures for every number, the same right-hand column for counts. A grid and a
tree that agree on row height and number alignment read as one product; a grid
at 28px next to a tree at 22px reads as two.

`tokens.css` gains a small third block — the grid's own hairlines, the selection
tint, the null ink, the plan's cost ramp — and no ground token, for the reason
stated at the top of that file.

### Icons

The eight object hues are already defined and already carry a silhouette each.
Phase 3 adds marks in the same system: a grid for a result set, a play triangle
for an execution, a clock for history, a bookmark for a saved query, a branching
tree for a plan, and two arrows for dependencies. Every one is a codicon or an
`ObjectIcon` silhouette, `currentColor`, no ids, legible under
`forced-colors: active`.

## IntelliSense

The completion engine is the feature people judge a database tool by in the
first ten minutes, so it gets its own section.

**The index.** Per connection, built once from `CatalogService` and refreshed in
the background: schemas, objects by kind, columns per relation, routine
parameters. Roughly a hundred bytes per object, so a fifty-thousand-object
database is five megabytes — held, because the alternative is a round trip per
keystroke. Built lazily on the first completion in a bound editor, not on
connect, and dropped with the session.

**The context.** A single-pass scanner over the text before the caret answers
four questions: which clause am I in, which relations are in scope, what are
their aliases, and is the token before me a dot. It is not a parser and does not
try to be — a full T-SQL grammar that must also parse half-typed statements is a
year of work that fails on the exact input it exists for, which is broken SQL.
The scanner is tolerant by construction: it finds `FROM`/`JOIN`/`UPDATE`/`INTO`
targets and their aliases even when the statement around them is incomplete.

| caret | offered |
|---|---|
| `SELECT ▏` | columns of relations already in scope, then `*`, then functions |
| `SELECT c.▏` | columns of whatever `c` aliases, only |
| `FROM ▏` | schemas, then tables and views, then table functions |
| `FROM dbo.▏` | objects in `dbo` |
| `WHERE c.Cust▏` | columns of `c` matching, fuzzy |
| `EXEC dbo.usp_▏` | procedures, with signature help behind them |
| `JOIN Orders o ON ▏` | the foreign-key join predicate, pre-written, ranked first |
| anywhere | keywords for the engine, snippets, last |

That last row before "anywhere" is the one that wins people over. When the
caret is after `ON` and the two relations in scope have a foreign key between
them, the first completion is the whole predicate —
`o.CustomerId = c.CustomerId` — because the index already knows the constraint
and typing it out is the most tedious keystroke in SQL.

Ranking is the explorer's own fuzzy matcher from `sidebar/fuzzy.ts`, reused
rather than reimplemented, so `uspgc` finds `usp_GetCustomer` in the editor
exactly as it does in the tree.

Identifiers are quoted only when they need it: a name that is not a plain
identifier or is a reserved word comes back as `[Order Details]` or
`"user"`, and one that does not stays bare. Always-quoting is what makes a tool's
generated SQL unreadable.

## Formatting

No dependency, engine-aware, and deliberately modest. A formatter that rewrites
somebody's SQL into a style they did not choose gets turned off, so this one has
five settings and a strong default: keyword case, comma position, indent, line
width, and whether `AND`/`OR` lead their line. It reuses the batch splitter's
scanner for tokenisation — the same code that has to know about dollar quoting
and bracketed identifiers — and formats statement by statement, so a
syntactically broken statement is left exactly as it was rather than mangled.

Registered as a `DocumentFormattingEditProvider` and a range provider, which
means Format On Save works, Format Selection works, and the keybinding is the
workbench's own.

## Component hierarchy

Four React roots. Each is its own esbuild entry point for the reason the
existing two are: a surface should not pay for a surface nobody opened.

```
results/index.tsx
└── StoreContext.Provider
    └── ResultsApp                      host messages, active execution
        ├── EmptyState                  "Run a query to see results"
        ├── ExecutionHeader             connection, elapsed, row count, cancel
        ├── Tabs                        Results · Messages · Plan
        ├── ResultsPane
        │   ├── ResultSetTabs           when a batch returned several
        │   ├── GridToolbar             filter, sort state, export, columns
        │   ├── Grid
        │   │   ├── HeaderRow → HeaderCell × visible
        │   │   ├── Viewport → Canvas → Row × visible → Cell × visible
        │   │   ├── SelectionLayer
        │   │   └── ResizeHandles
        │   ├── DetailPane              one cell, expanded
        │   └── GridStatus              rows, fetch state, truncation
        ├── MessagesPane                PRINT, NOTICE, errors with go-to-line
        └── PlanPane
            ├── PlanTabs                Graphical · Raw · Statistics
            ├── OperatorTree → OperatorNode ×n
            ├── OperatorDetail
            └── PlanWarnings

data/index.tsx
└── DataApp
    ├── DataToolbar                     object, filter, sort, refresh, export
    ├── Grid                            the same component
    └── DataStatus                      keyset paging, estimate, page size

runner/index.tsx
└── RunnerApp
    ├── RunnerHeader                    object, connection
    ├── ParameterForm → ParameterField ×n
    │   └── NullToggle, TypedInput
    ├── StatementPreview                disclosure
    ├── RunnerActions
    └── RunnerResults
        ├── Grid
        ├── OutputParameters
        └── ReturnValue

details/index.tsx
└── DetailsApp
    ├── ObjectHeader                    mark, name, kind, connection
    ├── TagStrip → Tag ×n
    ├── FactTable                       rows, columns, size, dates
    ├── QuickActions
    └── Sections → Section ×n           columns, indexes, keys, triggers, deps
        └── DependencyList → DependencyRow
```

Shared, in `webview/grid/` and `webview/primitives/`: `Grid`, `useVirtual`,
`useColumnWidths`, `useSelection`, `Toolbar`, `Tabs`, `Disclosure`, `Codicon`,
`ObjectIcon`, `EngineMark`. `Disclosure`, `Codicon`, `ObjectIcon`, `EngineMark`
and `Panel` exist today and are moved up rather than copied — they are already
shared between the two existing surfaces.

## Protocol

`src/shared/query.ts`, compiled by both sides, importing no `vscode`, holding no
credential — the same three rules `shared/protocol.ts` and `shared/sidebar.ts`
already state at the top of themselves.

```ts
/* host → results webview */
type QueryHostMessage =
  | { type: 'project'; tab: TabRef | null }             // the active tab changed
  | { type: 'started'; execution: ExecutionRef }
  | { type: 'columns'; executionId: string; setIndex: number; columns: ColumnMeta[] }
  | { type: 'rows'; executionId: string; setIndex: number; offset: number; rows: CellValue[][] }
  | { type: 'progress'; executionId: string; fetched: number; elapsedMs: number }
  | { type: 'message'; executionId: string; level: 'info' | 'error'; text: string; batch?: number; line?: number }
  | { type: 'finished'; executionId: string; outcome: ExecutionOutcome }
  | { type: 'plan'; executionId: string; plan: PlanNode }
  | { type: 'exported'; executionId: string; path: string; rows: number };

/* results webview → host */
type QueryWebviewMessage =
  | { type: 'ready' }
  | { type: 'getRows'; executionId: string; setIndex: number; offset: number; count: number }
  | { type: 'sort'; executionId: string; setIndex: number; column: number; direction: 'asc' | 'desc' | null }
  | { type: 'filter'; executionId: string; setIndex: number; text: string; server: boolean }
  | { type: 'export'; executionId: string; setIndex: number; format: ExportFormat; scope: 'all' | 'selection' }
  | { type: 'copy'; executionId: string; setIndex: number; range: CellRange; shape: CopyShape }
  | { type: 'cancel'; executionId: string }
  | { type: 'goToError'; executionId: string; batch: number; line: number }
  | { type: 'openPlanNode'; executionId: string; nodeId: string };
```

`rows` carries `CellValue[][]` — arrays, not objects — for the reason under
Memory. `CellValue` is the narrow union of what survives `postMessage`
structured cloning plus a tagged wrapper for the three that do not: `bigint`,
`Buffer` and `Date` become `{ t: 'n64' | 'bin' | 'ts', v: string }`, tagged so
the grid can render and the exporter can round-trip them. A `datetime2` that
arrives as a JavaScript `Date` and is rendered through the browser's locale is
the single most common data-corruption bug in database tooling, and the tag is
how it is avoided.

## Files

```
src/shared/
  query.ts                    host ↔ results/data/runner contract
  plan.ts                     the engine-neutral plan model
  details.ts                  object facts, tags, dependency shapes

src/exec/
  sessionPool.ts              control + exec leases, idle reaping, cancel
  executionService.ts         batches, streaming, cancellation, the sink
  splitter.ts                 the scanner: GO, statements, quotes, comments
  resultStore.ts              row buffers, spill file, offset index
  cancel/mssql.ts             request.cancel()
  cancel/postgres.ts          the protocol CancelRequest, pg_cancel_backend after
  guards.ts                   read-only and production gates

src/query/
  bindingStore.ts             uri → profile, persisted
  queryFs.ts                  the dbquery: FileSystemProvider
  definitionFs.ts             the dbobj: content provider
  historyStore.ts             JSONL, capped, redacting
  savedQueries.ts             files, header parsing, the tree
  format/                     tokenizer, formatter, options
  language/
    completion.ts             the provider
    context.ts                the tolerant scanner
    index.ts                  the per-connection metadata index
    signature.ts  hover.ts  definition.ts  diagnostics.ts

src/details/
  detailsService.ts           facts, tags, sections, caching on CatalogService
  mssql.ts  postgres.ts       one reader each, sharing only the answer's shape
  dependencies/mssql.ts       sql_expression_dependencies + the two DMVs
  dependencies/postgres.ts    pg_depend + pg_rewrite, with the labelled fallback

src/plan/
  planService.ts              request, capture, hand to the worker
  worker/planWorker.ts        showplan XML and EXPLAIN JSON → PlanNode

src/export/
  worker/exportWorker.ts      csv, tsv, json, sql, markdown, xlsx
  xlsx.ts                     zip + deflate, no dependency

src/ui/
  workspaceRouter.ts          address → reveal or open, the tab budget
  resultsView.ts              the panel webview view
  dataPanel.ts                dbdata: webview editor
  runnerPanel.ts              dbrun: webview editor
  detailsView.ts              the side bar webview view
  historyView.ts              the side bar webview view
  queryCommands.ts            run, cancel, explain, format, bind, save, share
  workspaceStatusBar.ts       the second status bar entry

src/webview/
  grid/                       Grid, useVirtual, useColumnWidths, useSelection
  results/  data/  runner/  details/     four roots, four entry points
  styles/{grid,results,data,runner,details}.css
```

`esbuild.mjs` grows from two webview entry points to six and from two
stylesheets to seven, plus two worker bundles built for Node and emitted beside
the host bundle. The reason for separate entries is unchanged and now matters
more: the sidebar is resolved at startup and must not carry a grid, a plan
renderer and an XLSX writer to draw a list of connections.

## What was built

All nine steps below are implemented and the extension builds and typechecks
clean. Where the code differs from the design above, this is the record of it
— each one is a decision made while building rather than a corner cut.

| step | state |
|---|---|
| Pool, splitter, execution, result store, cancellation | done |
| Results view and the virtualised grid | done |
| Query editors, binding, toolbar, keybindings, status bar | done |
| Table data with keyset paging | done, with the limit below |
| Details, tags, both dependency readers | done |
| Procedure runner | done |
| Completion, signature help, hover, definition, diagnostics | done |
| Plans, both engines | done |
| Export, history, saved queries | done |

### Where the code differs from the design

- **Exports and plan parsing run on the extension host, not in a worker.**
  The design put both in `node:worker_threads`. In practice the export loop
  yields to the event loop between five-thousand-row pages, which keeps the
  window responsive without the build plumbing a worker entry point needs —
  and the time in an export goes to the disk rather than to formatting. A plan
  large enough to block the host is rare enough to move later, with a
  measurement rather than a guess.

- **Fetch more re-runs the statement.** The design implied more rows came off
  a cursor that was still open. Holding a cursor would mean holding a
  transaction on a shared database for as long as somebody leaves a tab open,
  which is a far worse thing to do than running a query twice — so the button
  says `Run again for more` rather than `Fetch more`.

- **Keyset paging covers forward paging without a user sort.** Stepping to the
  next page seeks from the previous page's key and is constant-time at any
  depth. A jump, a page backwards, or a sort on a non-key column has nowhere
  to seek from and falls back to `OFFSET` — and the footer says which of the
  two is in force, rather than letting somebody discover it at page fifty.

- **Two side bar bundles, not four entry points.** Object details and query
  history share `panels.js`; the results panel, table data and the runner
  share `workspace.js`. The split that matters is the one the design argued
  for — the side bar, which is resolved at startup, carries no grid, no plan
  renderer and no spreadsheet writer.

- **`dbplan:` and `dbdeps:` were not needed.** A plan is a tab inside the
  results panel, and Dependencies opens a scripted listing in a query tab. Two
  schemes fewer for the same two features.

- **Diagnostics underline the line, not a span.** The server reports a line and
  a statement and never a column, so a range narrower than the line would be
  a guess that lands on the wrong token often enough to mislead.

## Known limits

Stated here so they are decisions rather than surprises.

- **The grid is read-only.** Editing needs a change set, a concurrency model and
  a DML preview, and half of it is worse than none.
- **PostgreSQL routine dependencies are incomplete**, because the server does
  not track them. The fallback is a labelled text search.
- **PostgreSQL has no created or modified date** for objects. It shows a dash.
- **Sorting a user's query sorts only the fetched rows**, and says so.
- **`Compare With` is scaffolded, not built.** Schema comparison is a feature the
  size of this whole phase; the quick action opens the two definitions in the
  workbench's own diff editor, which is genuinely useful and honest about being
  a diff of two scripts rather than a schema comparison.
- **No network, still.** No telemetry, no share targets, no plan upload, and the
  content security policy in every webview continues to forbid every one of
  them. Share copies to the clipboard or writes a file, and does nothing else.
- **Output parameters are lifted out of a result set.** SQL Server has no way
  to return them except as one, so the runner selects them and moves them into
  their own tabs. A procedure that happens to select a column called `Return
  value` as its last result set would be misread; that is the price of the
  server having no other channel.
