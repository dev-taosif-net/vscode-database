# Object explorer architecture

Phase 2 turns a connection from a leaf into a container. A connected
connection opens into its tables, views, procedures, functions, triggers,
sequences, types and synonyms; a table opens into its columns; a procedure
opens into its parameters. It is the same single-column webview the
connections list has always been — `docs/connections-explorer.md` covers the
list itself and everything below assumes it.

## What it looks like

Drawn at 260px, which is the canonical width.

```
┌──────────────────────────────────────────────────────────┐
│  ⌕ Search connections and objects…                   ⨯   │  32px, never scrolls
├──────────────────────────────────────────────────────────┤
│▏ ⌄    DEV     4                                          │  environment heading
│▏ ⌄ ●  Dev-Matador          sql-dev-01 · Matador   ⛁      │  22px, one line
│▏    ⌄ ★ Favourites                                  2    │
│▏      · 🟦 dbo.Customer                     34 columns   │
│▏      · 🟪 dbo.usp_GetCustomer             4 parameters  │
│▏    › 🗀 Tables                                  1,240   │
│▏    ⌄ 🗀 Views                                     420   │
│▏      · 🟩 dbo.vw_CustomerSummary           12 columns   │
│▏      · 🟩 sales.vw_OrderTotals              8 columns   │
│▏        ⌄ Load 498 more of 420                           │
│▏    › 🗀 Procedures                                980   │
│▏    › 🗀 Functions                                 430   │
│▏  ○   analytics-qa         pg-qa-3                🐘     │
└──────────────────────────────────────────────────────────┘
```

One row height everywhere: 22px, `list.rowHeight`, the value the workbench
gives its own trees. A connection was 34 and carried two lines while height was
doing the hierarchy, and it no longer needs to. A connection is the only thing
in the panel with an environment ribbon, a state glyph and a heading above it,
and nothing inside one has any of the three — so the eye finds the connection
it is inside without reading a word, and a folder of twelve hundred tables is
still a list somebody can scroll.

### The rail

```
 x=0  5   8        22   26        42   47              right
  ┌───┬────┬─────────┬────┬─────────┬────┬─────────────┬────────────┐
  │ ▏ │    │ twistie │    │  state  │    │ name · addr │ badge · ⛁  │  connection
  └───┴────┴─────────┴────┴─────────┴────┴─────────────┴────────────┘

 x=0   8+(lvl−1)×10        +14        +16                    right
  ┌───┬──── guides ────┬─────────┬──────────┬──────────────┬─────────┐
  │ ▏ │  indent lines  │ twistie │   mark   │     name     │  tail   │  node
  └───┴────────────────┴─────────┴──────────┴──────────────┴─────────┘
```

Both rails put their mark 16px wide with a 5px margin after it, and that is
what makes the second diagram a level *inside* the first. A connection's name
starts at 47; a folder inside it starts at `8 + (2−1)×10 + 14 + 4 + 16 + 5 =
57`, exactly one `--indent` to the right. It has not always been true. While
the connection row carried the engine mark between its state glyph and its
name, its own name began at 70 and the first level of the tree stepped
*backwards* by thirteen pixels — a child indented to the left of its parent.
Moving that mark to the trailing edge is what closed it.

The twistie is 14px wide with a 4px margin on every kind of row — a heading, a
connection, a folder — so the chevrons form one column down the panel. A
connection that cannot be expanded still reserves it rather than closing it up,
because a chevron column that is present on some rows and not others jogs the
whole rail by eighteen pixels as sessions come and go.

Indentation is 10px a level, not the workbench Explorer's 8. This tree goes
five deep — connection, schema, folder, object, column — where a file tree is
usually two, and eight pixels stops reading as a level once a chevron and a
mark sit between two of them. The guides are one `repeating-linear-gradient` on
a single pseudo-element rather than one span per level, because four spans per
row across a windowed list of a thousand rows is four thousand elements for
four lines.

### The right-hand column

`Tables 1,240` and `dbo.Customer 34 columns` put their number in the same
place. Counts and shapes form a column the eye runs down without reading a
label, and the counts are tabular figures so `1,240` over `420` over `980` line
up. Putting the count in brackets after the label, which is what SSMS does,
gives every row a different shape and destroys that scan at exactly the widths
where it matters. Below 196px an object gives up its detail and a column gives
up its type; a folder never gives up its count, which is four characters and
the whole reason to look at a folder you have not opened.

## The two modes

Saved per connection, in the host's memento, keyed by profile id. It is not on
`ConnectionProfile`: an explorer mode is a *reading* of a connection rather
than a property of it, and putting it on the profile would make switching modes
rewrite `updatedAt`, sort the connection to the top of "Recently updated", and
appear in the editor as an unsaved change to a connection nobody edited. Object
favourites live beside it for the same reason, and connection favourites were
already there.

**General**, the default. Kind folders directly under the connection, in a
fixed order that runs from the things a database is made of to the things wired
onto them: tables, views, procedures, functions, triggers, sequences, types,
synonyms. Object names carry their schema, because nothing above them says it.

**Schema-focused**, per connection. A schema level between the connection and
the folders. Object names drop the schema, because the row above them says it.

A folder whose count is zero is not drawn. The counts are already known before
any folder is opened, so an empty folder is a row that could never be useful.
PostgreSQL never draws Synonyms at all, because it has none.

There is no global toggle in the title bar, deliberately. A toolbar button
applies to the view and this applies to one connection: the estate that needs
schema mode is the forty-schema ERP database, and the three service databases
beside it in the same list do not. It is two commands rather than one that
flips, because a menu item has to say what it will do before it is clicked, and
`when` clauses over `dbSchemaMode` are how the menu picks between them.

## Loading

Nothing is read until something is opened, and then only what was opened.

| gesture | round trips |
|---|---|
| expand a connection | 1 — every count for every kind and every schema |
| expand a folder | 1 — 500 objects and the total |
| press Load more | 1 |
| expand a table or routine | 1 |
| switch to schema mode | 0 |

PostgreSQL adds one statement, once per session, before the first of those:
`server_version_num`, cached in a `WeakMap` keyed by the session. It is not
optional. `prokind` replaced `proisagg` and `proiswindow` in 11, `pg_sequences`
arrived in 10, `attidentity` in 10 and `attgenerated` in 12 — and referring to
a column that does not exist is a statement that fails to parse, not a field
that comes back null. So each of those is added to a statement only where the
server has it, and the version is what decides.

The one summary statement returns `(schema, kind, count)` triples, and
`foldSummary` folds them into both readings the tree needs: the general-mode
counts are the per-schema counts summed. That is why switching a connection to
schema-focused mode costs nothing — the answer was already here.

Every page statement selects `COUNT(*) OVER ()` alongside its rows, so a folder
learns how many it has and gets its first five hundred in one round trip rather
than two.

`CatalogService` holds the cache, coalesces requests, and maps a profile to the
engine that answers for it. Answers live five minutes. A connection that closes
loses its whole subtree immediately, because reconnecting may land on a
different database, a different server behind the same listener, or the same
server with different permissions — rows read through a session that is gone
are not stale, they are meaningless.

### How a folder asks

`flatten` is pure. It draws what it can and *reports* what it is missing as a
list of `Want`s; the panel's one effect sends them and a module-level set stops
the same one being sent twice. The alternative — an effect inside each folder
component — would put thirty windowed rows each deciding for itself whether to
fire a query, and a row that scrolled out of view mid-flight would cancel a
load the tree still needed.

## Search

The most important feature, and it is two searches that meet in the middle.

The moment a key is pressed, every object the panel already holds is fuzzy
matched and ranked locally. 250ms later the same query goes to every open
connection as a `LIKE` across all eight kinds, capped at 300 per connection;
what comes back is merged, deduplicated by kind, schema and name, and ranked by
the same function. The first half is why it feels instant. The second is why
the answer is not limited to the folders you happened to have opened, which in
a fifty-thousand-object database is the difference between a search and a
filter.

The matcher is a subsequence match with a bonus table, not an edit distance.
People type an abbreviation of a name they already know — `uspgc` for
`usp_GetCustomer`, `custaddr` for `CustomerAddress` — and a subsequence match
is right for that, where an edit distance treats six missing characters as six
errors and ranks the thing you meant below the thing you did not. An exact
substring is scored as a different kind of answer entirely, so `customer` ranks
`Customer` over `CustomerAddress` over `usp_CreateCustomerMap`.

The box takes a type and a schema as well as a name:

| typed | means |
|---|---|
| `customer` | that name, anywhere, plus connections matching it |
| `sales.customer` | that name in `sales` |
| `proc:customer` | that name, procedures only |
| `sequences` | every sequence |

A query carrying a type or a schema is unambiguously about objects, so the
connection list is left out of the answer rather than showing every connection
whose name happens to contain `dbo`.

Searching replaces the tree rather than filtering it. Results are flat, grouped
under a sticky per-connection heading, and nothing is expanded — the hierarchy
is precisely what a search exists not to walk. The heading sticks because
`dbo.Customer` exists on all four servers and the connection is the only fact
that separates them.

## Colour and shape

Eight object hues, and every mark also has a silhouette of its own:

| kind | hue | silhouette |
|---|---|---|
| folder, schema | neutral | folder with a tab |
| table | blue | framed grid with a header band |
| view | teal-green | two offset panes — a view is drawn from something |
| procedure | purple | rounded square, play triangle |
| function | amber | rounded square, ƒ |
| trigger | red | lightning bolt |
| sequence | orange | up arrow with rungs |
| type | slate | gear |
| synonym | cyan | chain link |
| favourite | gold | star |

The square is shared by the two kinds you run, so the container says *routine*
and the glyph inside says which. Everything else has a silhouette shared with
nothing.

The first row of that table is the one worth explaining. Every *container* — the
kind folders and every schema — draws one folder in one neutral, and the eight
hues are spent only on the things inside them. They used to be spent twice: a
folder called Tables in table blue, holding twelve hundred tables in table
blue, with four unrelated silhouettes stacked in one column each announcing
what its own label already said. Leaving hue to the leaves makes it mean
exactly one thing — this row is an object, and this is its kind — and leaves
the container column to be read as structure. A schema and a kind folder are
told apart by their depth and their name, which is how a file tree has always
done it. Favourites keeps its star: it is a list you built, not a place in the
database.

Shape is not decoration here. A hue can be taken away — by a high-contrast
theme, by `forced-colors`, by one man in twelve — and a set that differed only
in hue would collapse into eight identical grey rectangles the moment it was.
Print the set in black and every mark is still nameable. Under
`forced-colors: active` every mark renders `CanvasText` and the tree still
reads.

These are deliberately *not* the environment hues. `--env-qa` is `#4a93f0` and a
table is `#4d9de0`: near neighbours, never the same swatch, and never in the
same column. The environment hues live in a connection row's left rail and its
heading — a 3px ribbon, a state disc, a short badge. The object hues live
inside a connection, on a 16px mark at a different x, on a shorter row. Nothing
in the panel shows one of each at the same indent.

## The menus

Real workbench menus, built from `when` clauses over the keys each row puts in
`data-vscode-context`. That is what lets one contributed menu give a table
Select Top 100 and Generate CRUD while giving a procedure Execute and Script As
ALTER.

```
connection                     table                procedure / function
  Connect | Disconnect           Open Definition      Open Definition
  Refresh Objects                Select Top 100       Execute
  ─────────────                  Generate CRUD        Script As ALTER
  Add to Favourites              ─────────────        ─────────────
  Enable Schema Focused Mode     Copy Name            Copy Name
  ─────────────                  Copy Full Name       Copy Full Name
  Edit Connection                ─────────────        ─────────────
  Duplicate Connection           Add to Favourites    Add to Favourites
  Copy Server Address
  ─────────────
  Delete Connection
```

Every object action ends in a SQL document rather than a result grid, because
phase 2 has no execution engine — there is nowhere to put rows yet. These
commands are shaped around that rather than hiding it: each opens an untitled,
editable document holding a statement that is complete and correct for the
object it came from. Untitled rather than read-only, because a definition is
most useful as a starting point. When the grid lands, Execute becomes a verb
rather than a scaffold and none of the SQL has to change.

Generate CRUD is the one that has to be exactly right, and two details carry
it. Identity, `serial`, computed and generated columns are left out of the
`INSERT` and out of the `SET` list, because the server refuses both. And
PostgreSQL placeholders are numbered once across a whole statement rather than
per clause — an `UPDATE` whose `SET` and `WHERE` both start at `$1` binds the
key into the first column being set, which runs, corrupts one row, and reports
success.

## Keyboard

The workbench's own tree gestures, now across five levels. `→` opens what is
closed and steps in when it is already open; `←` closes what is open and steps
out when it is already closed. Stepping out uses `parentOf`, which climbs the
real tree — a column reaches its table, its table reaches its folder, its
folder reaches its connection — rather than jumping to the environment heading
the way the flat list's `owner` did.

`Enter` opens whatever the cursor is on. On a connected connection that means
its subtree; on a saved one it means the connection editor. `Space` keeps its
phase-1 meaning on a connection — connect, disconnect, or cancel — and is
`Enter` everywhere else, because only a connection has a session to open.

**One phase-1 gesture changed.** Clicking a connected connection now expands it
instead of opening the editor. A row that did both on one click could do
neither predictably, and editing a connected connection moved to Edit
Connection on its right-click menu, which is where the explorer's own
specification put it. A saved connection is still a leaf and still opens its
editor on a click.

## Accessibility

- Every node is a `treeitem` with `aria-level`, `aria-posinset`, `aria-setsize`
  and, where it opens, `aria-expanded`. `aria-level` counts the section heading
  above it; `depthOf`, which drives indentation and `←`, does not — the two are
  deliberately different and computed in one place.
- Roving tabindex, unchanged: the cursor is the tree's single tab stop.
- The search box announces objects as well as connections. A user who types
  `customer`, hears "0 of 84 connections match" and is not told about the forty
  objects on screen has been told the opposite of the truth. The count comes
  from `flatten`, which is the only thing that does the matching.
- Loading, empty, error and Load more are rows in the tree rather than overlays,
  so a folder that is loading occupies exactly the row it will occupy when the
  answer lands and nothing under it jumps.
- A folder that cannot be read reports on itself and leaves the rest of the tree
  alone, which matters most where it is most likely: a production login with
  rights to four schemas out of forty.

## Files

```
src/shared/catalog.ts           kinds, node keys, wire shapes; host and panel
src/catalog/
  types.ts                      the CatalogQueries interface
  fold.ts                       the two helpers neither engine owns
  mssql.ts                      sys.* — not INFORMATION_SCHEMA
  postgres.ts                   pg_catalog — with 9.6 / 10 / 11 / 12 floors
  script.ts                     every statement the extension writes
  catalogService.ts             cache, coalescing, invalidation
src/ui/objectCommands.ts        the object row's menu
src/webview/
  primitives/ObjectIcon.tsx     fifteen marks, currentColor, no ids
  sidebar/fuzzy.ts              the matcher and the query parser
  sidebar/model.ts              FlatItem, flatten, geometry, Want
  sidebar/TreeRow.tsx           folder, schema, object, member, note, results
```

Neither engine's reader imports the other's. `sys.objects` and `pg_class`
disagree about what an object even is — SQL Server has synonyms and PostgreSQL
has materialized views, a SQL Server function is one of six `type` codes and a
PostgreSQL function is a `prokind` — and a layer that flattened the two would
produce a tree that is wrong about both. They share the shape of the answer and
nothing else.
