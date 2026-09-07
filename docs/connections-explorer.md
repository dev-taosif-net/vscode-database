# Connections sidebar architecture

The connections view is a React application compiled into a VS Code webview and
rendered in the sidebar. This document covers why it stopped being a tree, what
it is made of, how a hundred rows scroll without doing React work, how it
borrows the workbench theme, and what it does for people who do not use a
mouse. `docs/ui-architecture.md` covers the connection editor, which is the
other webview. The two share a token layer, a store implementation and two
primitives, and nothing else.

## Why it is not a tree

A `TreeItem` is a label, a description, one icon and a tooltip, drawn by the
workbench. `connectionsTree.ts` had six things to say about a connection — the
name, the environment, the server, the database, what state it is in, and
whether it is read-only — and four slots to say them in. What it did with them
is worth reading, because it was the best available reading of the constraint
and it is still the reason the constraint had to go:

- the name went in the label;
- the environment and the server shared the description, `grouped ? target :
  SHORT · target`, so the environment was only ever visible when grouping was
  off;
- the state and the environment shared the *icon*: shape for state, colour for
  environment. One slot carrying two readings.
- everything left — the database, read-only, the transport, the auth method,
  the live session's version and principal — went into the tooltip, which is a
  hover away and invisible to a scan.

The icon is where it breaks. A failed production row has to say both *failed*
and *production*, and there is one icon. `ConnectionTreeItem` resolves it by
letting failure win the shape and take a neutral warning colour, so the row
stops saying which environment it is in at the exact moment that matters most.
No arrangement of a label, a description and one icon fixes that; there are not
enough slots.

Beyond the row there are things a tree cannot do at all. A search box that is
always on screen rather than a quick input that closes. More than one inline
action per row, laid out to a pixel budget. A footer. A state readout that
follows the cursor. A production alarm that no filter can hide. A per-group
ribbon down the left edge. Search hits marked inside the name they matched.
Extra sidebar width spent on extra columns rather than on a longer description.

So the view became `"type": "webview"` and draws itself.

**The bill.** A `TreeView` gives drag and drop, type-ahead, keyboard handling,
accessibility and virtualization for free. This design ships no drag and drop
at all, replaces type-ahead with a real search box, and re-implements the last
three by hand. Sections below say what each of those cost.

What did *not* change is where state lives. `ConnectionStore` owns the
profiles, `ConnectionManager` owns the sessions, and `ConnectionsView` owns only
the *reading* of that list — grouping, sort, and which environments are folded
away. It holds no profile and no session of its own.

## Layout

Drawn at 260px, which is the canonical width.

```
┌──────────────────────────────────────────────────────────┐
│ DATABASE CONNECTIONS      84 · 3 open   ⌕ ＋ ⟳ ⑂ ⊘       │  35px, drawn by the workbench
├──────────────────────────────────────────────────────────┤
│  ⌕ Name, host, database                              ⨯   │  search band, 32px, never scrolls
├──────────────────────────────────────────────────────────┤
│  ⌄ 📌 PINNED                                         2   │  section header, 24px, sticky
│▌  ●  ⛁  PROD billing-write     sql-prod-01      LIVE     │  a pinned row keeps its own ribbon
│▏  ○  ⛁  DEV  local-scratch     localhost                 │
│▌ ⌄ 🛡  PROD Production                       9 · 1       │  group header, riskiest group first
│▌  ○🔒 ⛁  billing              sql-prod-01                │
│▌  ●🔒 ⛁  billing-reports      sql-prod-01       LIVE     │
│▏ ⌄ ●   QA   Quality Assurance                   18       │
│▏  △  🐘 analytics             pg-qa-3           FAIL     │
│▏  ◐  ⛁  reporting             rpt-qa-01         TEST     │
│▏  ○  ⛁  orders-read           orders-qa-01              ░│  the scroller — the only thing
│                                                          │  that scrolls
├──────────────────────────────────────────────────────────┤
│▌ 🛡 billing-reports · read-only                  Close   │  production band, 18px, present
├──────────────────────────────────────────────────────────┤  only while a prod session is open
│ ● 3   ○ 78   △ 2                              84         │  footer, 22px, never scrolls
└──────────────────────────────────────────────────────────┘
```

The search band and the footer hold still; only the scroller moves. That is the
same rule the editor follows for the same reason — the thing you use to find a
row must not be a thing you have to scroll back to.

Every row is the same 22px at every width, in every state, in every tier. That
is `list.rowHeight`, the value the workbench gives the Explorer and Source
Control views sitting in the same sidebar, and it is the property the whole
design is built on. It removes the hardest problem in a resizable panel: there
is no `ResizeObserver` on width, no measured probe row, no `getComputedStyle`
handshake, no breakpoint hysteresis, and no pair of constants that CSS and
JavaScript can disagree about while the sash is being dragged.

**The slot ruler.** Identical on every row, at every width, in every state.

```
 x=0  3    8         24  28        44   52                    W-16  W-8
  ┌───┬─────┬──────────┬───┬────────┬────┬──────────────────────┬─────┐
  │ ▏ │     │  state   │   │ engine │    │  name · host · db    │ badge│
  └───┴─────┴──────────┴───┴────────┴────┴──────────────────────┴─────┘
    3   5px     16px     4px  16px    8      elastic run          38+8

  ribbon 0..3, state glyph at x=8, engine mark at x=28, text begins at x=52.
  right: 8px pad + 8px of scrollbar-gutter: stable.
  elastic = W − 68.   170px → 102     260px → 192     500px → 432
```

The left rail is a fixed 44px and nothing ever moves it. That is what makes the
glyph column a column rather than a ragged edge, and the whole first reading
depends on it.

`scrollbar-gutter: stable` reserves the 8px rather than overlaying it, because a
scrollbar that appears the moment the list outgrows the viewport reflows every
row underneath it. The webkit scrollbar is narrowed from `editor.css`'s 12px to
8px: 12 of 170 is seven per cent of the panel.

## The reading order

The list is read as three vertical columns of glyphs and one column of names,
not as a hundred rows of prose. Everything below serves that.

**First — the state glyph column, x=8 to x=24.** It is the only place in a row
where a filled shape appears. A filled disc in a field of hollow rings is a
pre-attentive pop-out: you find the four live sessions among eighty-four rows
before you have read a word.

**Second — the connection name.** The only 13px text in the panel. Everything
else is 11px or under, so three text elements on one line never compete: the
ramp is luminance and weight, not size. Weight does the second-order state
encoding for free — a saved row's name is 450, a connected row's is 600, so the
live rows are also the bold rows.

**Third — the environment ribbon at x=0**, read as a column rather than per
row. One unbroken 3px bar per group, at 55% for dev, qa and uat and 100% for
production, so production is the only saturated ribbon in the panel and reads
as a contrast difference along the left edge without focusing on any row. A
connected row paints a 100% segment over its own slice through
`.row.is-live::before`, so the ribbon column is also a state readout: a mostly
faint bar with bright ticks where sessions are open.

**Fourth, and only once you have committed to a row** — the host in mono, then
the database, then the state badge at the right edge.

### The type ramp

Nothing is sized in `em`, and the sidebar never reads `--vscode-font-size`.
That is deliberate and load-bearing: the row is a hard 22px and a font that
followed the user's editor settings would clip it, while the virtualizer's
offsets would still say 22 — geometry that is truthful about a row that is
visibly wrong. The workbench's own tree does exactly this: list rows are 22px
regardless of `editor.fontSize` and follow `window.zoomLevel` only, which scales
the whole webview uniformly and keeps the ratio. `sidebar.css` carries that
sentence above the type block and `model.ts`'s `H` table cross-references it,
because it is the rule most likely to be helpfully "fixed".

| element | size | weight | tracking | colour |
|---|---|---|---|---|
| connection name, saved | 13px | 450 | — | `--fg` |
| connection name, connected | 13px | 600 | — | `--fg` |
| environment short badge | 10.5px | 700 | 0.08em | `--env-*-ink` |
| environment full label | 11px | 400 | — | `--fg-dim` |
| guard sentence | 10.5px | 400 | — | `--fg-dim` |
| host | 10.5px mono | 400 | — | `--fg-dim` |
| database | 10.5px | 400 | — | `color-mix(in srgb, var(--fg-dim) 78%, transparent)` |
| auth label, ≥560px | 10.5px | 400 | — | `--fg-dim` |
| state badge | 9.5px | 600 | 0.04em, uppercase | state ink |
| section count | 10px | 500 | — | `--fg-dim` |
| footer counts | 11px | 400 | — | `--fg-dim` |
| footer readout | 10.5px mono | 400 | — | `--fg-dim` |
| production band | 11px | 600 | — | `--env-prod-ink` |
| search input and placeholder | 12px | 400 | — | `--vscode-input-foreground` / `-placeholderForeground` |

The host is monospace because `10.0.14.22` and `10.0.14.23` are only separable
in a fixed pitch, and because it gives the line a texture the eye can skip when
it is not looking for a host.

### What each colour means

Each hue means one thing and appears in one place.

- `--env-dev-ink` / `--env-qa-ink` / `--env-uat-ink` / `--env-prod-ink` —
  environment identity, and nothing else. Four places: the group ribbon, the
  header glyph, the header's short badge, and the row's state disc or ring. On
  a pinned row and in flat mode they also colour the row's own short badge,
  because there is no header above it to say the environment.
- `--warn-ink` — failure, and nothing else. The `warning` triangle and the
  `FAIL` badge. Never a ribbon, never a header.
- `--busy`, from `--vscode-progressBar-background` — an attempt in flight, and
  nothing else. It is the workbench's own token for this and it is defined in
  both high-contrast themes, which `--fg-dim` is not a substitute for.
- `--mark`, from `--vscode-list-highlightForeground` — the matched substring
  inside a name, host or database while a search is running, and nothing else.
  It is the tree's own match-highlight token.
- `--hover`, `--sel`, `--sel-active` — the only backgrounds any row ever gets.
  Connectedness and production get no background at all. A row can be both
  connected and selected, and a background is the channel selection owns; forty
  washed production rows are wallpaper.
- `--focus`, from `--vscode-focusBorder` — focus, and nothing else.
- `--fg`, `--fg-dim` — every neutral.

There is no `--bad` token in the sidebar. In `editor.css` it falls back to the
same `charts.red` that `--env-prod` is, and in a list of eighty-four rows a red
mark that could mean either "danger, production" or "this failed" is a red mark
you have to decode. Red carries one meaning here, and failure moved to amber.

That leaves two ambers — UAT's ribbon and the failure triangle — separated by
slot and by shape and never by hue. UAT amber only ever appears as a 3px bar at
x=0 and as a badge inside a section header; failure amber only ever appears as a
12px triangle at x=8 and as a badge at the right edge. They never occupy the
same slot on the same row, and either one alone identifies itself. A fifth hue
that no theme token supports would be worse.

**Why "saved" carries no badge.** On a realistic list seventy-eight of
eighty-four rows are saved. Eighty-four badges of which seventy-eight say the
same word is not information, it is ink competing with the name for the 148px
the row has. Saved is encoded as the absence of a badge plus a hollow ring — a
real encoding rather than an omission, because the absence is only legible while
the other three states reliably produce a mark. The word is on screen the
instant the cursor lands on the row, and it is always in the row's accessible
name.

## Component hierarchy

```
src/webview/sidebar/index.tsx
└── <StrictMode>
    └── Sidebar
        │   owns:  the window 'message' listener; the whole keyboard model;
        │          focus restoration; persisted scrollTop through api.setState
        │   subs:  listStore.ready, listStore.rows.length
        │
        ├── SearchBand
        │       owns:  the <input>; the debounced {filtered, matched} post
        │       subs:  listStore.query        writes: listStore.query
        │
        ├── EmptyState                        rows.length === 0 && no query
        │       owns:  nothing. Posts {type:'new'}.
        │
        ├── VirtualList
        │   │   owns:  the scroller; the Geometry memo; local [first,last];
        │   │          the rAF scroll coalescer; a height-only ResizeObserver;
        │   │          the overlay's transform, written to a DOM ref rather
        │   │          than through React
        │   │   subs:  listStore; sessionStore (the open-id set only);
        │   │          cursorStore.cursorId, purely to keep the cursor mounted
        │   │
        │   ├── StickyHeader        aria-hidden overlay, absolute, top: 0
        │   │       owns:  nothing. A copy of items[owner[first]].
        │   │
        │   ├── PinnedHeader        kind: 'pinned'
        │   ├── GroupHeader × n     kind: 'group'
        │   │       owns:  the twistie. Posts {type:'collapse'}.
        │   ├── Row × n             kind: 'row', React.memo
        │   │   │   props: id, top, pinned, showBadge, level, posinset,
        │   │   │          setsize, needle, hit — every one a primitive, so a
        │   │   │          sub-row scroll re-renders none of them
        │   │   │   subs:  useRow(id) · useSession(id) · useIsCursor(id) ·
        │   │   │          useIsSelected(id)
        │   │   ├── StateGlyph      disc / ring / triangle / arc, plus the lock
        │   │   ├── EngineMark      the existing primitive, size 16, no plate
        │   │   ├── NameRun         env badge? · name · host head+tail · db
        │   │   ├── StateBadge      LIVE / FAIL / TEST / nothing
        │   │   └── ActionRail      hover and focus-within only; tabindex=-1
        │   └── NoMatch             kind: 'nomatch'
        │
        └── Footer
            │   subs:  sessionStore (all of it), cursorStore, listStore
            ├── ProductionBand      role="status" + a one-shot sr-only alert
            ├── Counts              aria-live="polite"
            └── Readout             the cursor row's detail; aria-hidden
```

`GroupHeader` and `PinnedHeader` subscribe to nothing. Their counts arrive as
props on the `FlatItem`, including the `open` count that makes a header say
`18 · 2 open`, so a session change re-renders at most the headers whose number
actually moved rather than every header on screen.

`ActionRail`'s buttons carry `tabindex="-1"` and are never in the tab order.
That is exactly how a native `TreeView`'s inline actions behave, so it is not a
regression, but it is not good either — every action on the rail is also a
direct key or an entry in the `⋯` quick pick, which is the same menu at every
width.

The rail's text fade is `-webkit-mask-image` on `.run`, not a colour gradient.
A colour gradient has to fade to whatever the row's background currently is —
plain, hover, inactive selection, active selection — and CSS cannot name that
composite. A mask does not care what is behind it, which is also why it survives
high contrast and forced colours. But masking creates a stacking context and can
force a composited layer, so the rule lives only under `.row:hover` and
`.row:focus-within` and never on the base `.row`: at most one row is masked at
any moment. If a profiler ever shows a layer per row, that selector has been
widened, and the fix is to narrow it back rather than to replace the mask.

`primitives/Codicon.tsx` and `primitives/EngineMark.tsx` are reused from the
editor unchanged. Nothing else is shared, and in particular **nothing under
`sidebar/` may import `state/vscode.ts`**: that module calls
`acquireVsCodeApi()` at module scope and is typed to the editor's message union,
and calling `acquireVsCodeApi()` twice throws. The sidebar has its own `api.ts`
with its own acquire, typed to `SidebarWebviewMessage`.

## State

```
        host                                webview
  ConnectionsView  ─── state ───────────▶  listStore   ─┐
        │          ─── sessions ────────▶  sessionStore │
        │          ─── reveal ──────────▶  cursorStore ─┴─▶ Geometry ─▶ rows
        ▲
        └── open/connect/disconnect/cancel/favourite/menu/filtered ── post
```

Three stores, all built by `state/store.ts` — the same fifty-line
subscribe-with-a-selector store the editor uses, read through
`useSyncExternalStore`. The split is the entire performance argument, so it is
worth stating plainly.

- **`listStore`** — `rows`, `byId`, `grouped`, `sort`, `collapsed`, `query`,
  `ready`. This and only this feeds the geometry. **A connection going live must
  never touch it.**
- **`sessionStore`** — a `Record<id, SessionUpdate>` holding only the rows that
  are *not* saved. Rows subscribe to it one id at a time.
- **`cursorStore`** — `cursorId` and `selectedId`. Changes at click and keypress
  rate.

The reason there are three is in `src/shared/sidebar.ts`, in the split between
`ConnectionRow` and `SessionUpdate`. `ConnectionRow` is the structural half —
name, driver, environment, host, port, database, favourite, read-only,
`updatedAt` — and it is everything that survives a session change. `SessionUpdate`
is the volatile half — the state, the failure title, the live session's facts —
and it arrives on its own `{type:'sessions'}` message. While the state lived on
the row, a single connect rebuilt the whole `rows` array, which rebuilt the
flattened index, which handed every windowed row a new identity: thirty
re-renders for a change that visually touches one row.

With the split, a connect posts `sessions`, `sessionStore` is replaced whole,
and `listStore` never hears about it. `useSession(id)` returns a new object for
the handful of ids that actually have one; every other row's selector returns
`undefined`, identical to last time, and `useSyncExternalStore` does not
re-render it.

The host is also sent a *projection* rather than the profiles. A
`ConnectionProfile` carries forty fields, most of them credential-adjacent — the
login name, the Entra account, the NTLM domain, three certificate paths. A list
that draws a name, a host and a badge has no business holding any of them, so a
bug in the panel cannot leak one, and the message stays two hundred rows of ten
fields rather than two hundred profiles of forty.

**The four hooks are not a convenience.** `useStoreSelector` memoises its
snapshot on `[store, select]`, so an inline arrow — `useStoreSelector(sessionStore,
s => s[id])` — produces a new `select` on every render, which changes the
`useCallback` deps, which makes `useSyncExternalStore` unsubscribe and
resubscribe. Across a thirty-row window that is sixty `Set` mutations per frame.
It will not throw, it will not warn, and it will not show up at ten connections.
`useRow`, `useSession`, `useIsCursor` and `useIsSelected` in `sidebar/state.ts`
each hold their selector stable through `useCallback([id])` and are the **only**
sanctioned way to read a per-row value. Anything else calling `useStoreSelector`
inside `Row.tsx` is a review failure.

The same trap catches the open-id set that `flatten` needs. `sessionStore` holds
one object that is replaced wholesale, so a selector may return *that object*
and stay stable; a selector that returns `new Set(...)` returns a new reference
every time it is called and loops. The set is built inside the memo, from the
map, never inside the selector.

**There is no scroll store.** Scroll position lives in a ref inside
`VirtualList`. The only thing the panel persists for itself is `scrollTop`,
through `api.setState`, because losing it every time the view is collapsed is
the whole reason `PersistedSidebar` exists. Grouping, sort and which
environments are folded live in the host's memento instead, because the
title-bar toggles need them for their `when` clauses and a single source of
truth belongs on the side that owns the commands.

The search query is deliberately *not* on the host. A filter that round-trips
on every keystroke is a filter that stutters at two hundred rows. What the host
is told is `{type:'filtered', on, matched}`, debounced — `on` drives the
`databaseTools.filtered` context key that shows the Clear action, and `matched`
lets `view.description` say `12 of 84` the way the tree's own count label did.

## The flattened model

`flatten()` in `model.ts` turns the whole list into one array of positioned
things — headers and rows in one sequence — and `measure()` turns that into a
`Geometry`.

```ts
const geom = useMemo(
  () => measure(flatten({ rows, grouped, sort, collapsed, query, open }).items),
  [rows, grouped, sort, collapsed, query, open]
);
```

At a hundred connections plus five headers, `flatten` touches 105 entries and
`measure` allocates two typed arrays of 106 and 105 elements — roughly 850
bytes, a few microseconds. It runs when a profile changes, when a group folds,
when the query changes, and when the set of open sessions changes. Not per
frame, not per scroll.

That last dependency is the one place this widened. `open` is derived from
`sessionStore`, so a connect *does* re-run `flatten` and `measure`. What it
cannot do is move anything: an open count changes no height, so no offset moves,
no row's key changes, and every `Row` prop is the same primitive it was. React
reconciles the window and `React.memo` bails on every row in it. The only
component that actually re-renders is the group header whose number changed.
The rule the split protects is "a connect must not re-render rows", and it
holds; "a connect must not touch the index" is the stronger form, and the price
of the stronger form was a group header that could not count its own open
sessions without every header subscribing to the session map.

**The height table** is four constants in `H`, and `heightOf` is total over the
discriminated union so TypeScript proves it exhaustive.

| item | height | |
|---|---|---|
| `row` | 22 | `list.rowHeight` |
| `group`, expanded | 24 | |
| `group`, collapsed | 40 | 24 plus a 16px guard line |
| `pinned` | 24 | |
| `nomatch` | 44 | |

A collapsed header is *taller* than an open one because it spends the vertical
budget it just freed on `ENVIRONMENTS[].guard`, verbatim, on one ellipsised
line. That is information appearing exactly where space became free, and it is
what makes Collapse All an orientation view — four groups folded into four 40px
guard cards on one screen — rather than only a way to hide rows. It is also
what replaced a scrollbar minimap: a standard `view/title` action that costs
nothing and has a high-contrast definition, against a painted surface that has
neither.

**Offsets** are one `Int32Array(n+1)` prefix sum, built in the same O(n) pass as
`owner` (the index of the section header owning each item, or −1) and `headers`
(every header index, at most six). `indexAt` is an upper-bound binary search:
log₂(106) ≈ 7 comparisons, and it clamps to the last item.

**Ordering.** `compare(sort, a, b)` is the tree's own `RANK` carried forward —
riskiest first, so a production profile is never scrolled out of sight — and the
groups themselves are ordered by the same rank, so PROD is the first group.
Sorting production rows to the top *within* a group was considered and refused:
it makes the list move under the cursor at the exact moment the user is acting
on production.

**Pinning.** `flatten` partitions on `favourite` before it groups, so a pinned
connection is **lifted out of its environment group, not duplicated**. The two
sets are disjoint by construction and every group count is therefore true about
what is on screen. Showing a pinned row in both places would make "22 rows
visible" mean fewer than 22 distinct connections. A lifted row's container no
longer says what environment it is in, so `showBadge` is set and the row carries
its own short badge as the first element of the elastic run — the same rule
`connectionsTree.ts` applied with `grouped ? target : SHORT · target`, extended
to the pinned section, and it fires in flat mode too. The PINNED header itself
carries no ribbon; its rows keep theirs, so the ribbon column beside the pinned
section is multicoloured while every real group's is a single hue. That texture
difference is how you tell the two apart at a glance, at any width, with no icon
and no reading.

Pins live in `globalState` beside the profiles rather than inside them, because
a pin is a reading of the list rather than a property of the connection: pinning
never rewrites `updatedAt` and never appears as a change the editor would offer
to save. The rail's star posts `{type:'favourite'}` and waits for the round
trip; there is no optimistic local toggle, because the list is redrawn from one
source of truth.

**Searching.** `matchRow` returns `null` for a row the query removed, an empty
array when there is no query, and otherwise the list of fields that matched —
which becomes the `hit` prop and the row's `data-hit` attribute. Three details
are decided here rather than in CSS:

- A query force-expands every group: `collapsed = needle ? false : folded.has(env)`.
  A filter that hides its own matches inside a folded group reads as a filter
  that found nothing.
- A pinned row that is filtered out is not shown anywhere else either. There is
  no "but it's pinned" exemption, because a filter that keeps showing rows it
  filtered out is not a filter.
- `productionHidden` counts the production rows the query removed, so the footer
  can say `12 of 84 · 4 production hidden`. A production row silently absent
  from a filtered list is the one omission this design will not make.

When nothing survives, `flatten` emits a single `nomatch` item rather than an
empty array, because an empty list reads as "there are no connections". There
are; they are filtered out, and saying so is the difference.

## Virtualization

**The scroll loop does no React work for a sub-row scroll.**

```
onScroll(e):
    rawTop.current = e.currentTarget.scrollTop
    if (frameQueued) return
    frameQueued = true; requestAnimationFrame(tick)

tick():
    frameQueued = false
    const top = rawTop.current
    const nextFirst = virtual ? max(0, indexAt(geom, top) - OVERSCAN) : 0
    const nextLast  = virtual ? min(n-1, indexAt(geom, top + viewportH) + OVERSCAN) : n-1
    writeOverlay(top)                                   // direct DOM
    if (nextFirst !== first || nextLast !== last)
        setWindow({ first: nextFirst, last: nextLast })  // the only setState
    persistScroll(top)                                   // throttled to 250ms
```

Scrolling a 22px row by three pixels writes one transform and nothing else.
Crossing a row boundary re-renders `VirtualList`, and React reconciles about
thirty keyed elements whose props are all unchanged primitives and bails on
every one. `OVERSCAN` is 8 — 176px above and below, cheap insurance against a
fast flick.

**Above 120 items, and only above 120 items, the window is narrowed.**

```ts
const VIRTUALIZE_ABOVE = 120;
const virtual = geom.items.length > VIRTUALIZE_ABOVE;
```

Below it, `first = 0` and `last = n − 1`: the whole list is in the DOM. 120
items at 22px is 2,640px, about four viewports of six-node rows — roughly 720
nodes, which costs nothing. Everything else is identical in both modes:
absolute positioning inside the spacer, the overlay header, the ribbons, the
explicit `aria-setsize`. There is one geometry model and one sticky mechanism to
maintain, and what the threshold buys is that the large majority of users get a
complete DOM and therefore an unbroken screen-reader browse mode with no ARIA
compensation at all.

**The cursor row is always mounted.** Above the threshold, if the cursor index
falls outside `[first, last]`, that item is rendered anyway as one extra
absolutely-positioned row at its true offset. It will be off-viewport, but it is
in the DOM, so focus is never silently destroyed by a scroll. This is
non-negotiable and it is the single rule most hand-rolled virtualizers get
wrong.

**Sticky headers are an overlay, not `position: sticky`.** Sticky does not
compose with absolutely-positioned rows inside a spacer, so one `StickyHeader`
element lives outside the scrolled content as an absolutely-positioned sibling
at `top: 0` of the viewport. Its content is `geom.items[geom.owner[first]]` —
the owning header is already known from the `owner` array, at no search cost.
Push-off is the iOS behaviour:

```
const h = geom.owner[first];                  // -1 → render nothing
const hi = geom.headers.indexOf(h);           // headers is at most six long
const next = geom.headers[hi + 1];
const nextTop = next === undefined ? Infinity : geom.offsets[next];
const dy = Math.min(0, nextTop - top - heightOf(geom.items[h]));
overlayRef.current.style.transform = `translateY(${dy}px)`;
```

One transform write per frame, no layout, no React. When the owning header is
itself the first visible item, `dy` is 0 and the overlay sits exactly on top of
the real one, which is at `offsets[h] − top ≤ 0` and clipped by the scroller, so
there is no visible double. The overlay carries its own 3px ribbon segment in
the group's hue, so the ribbon column stays unbroken where it covers it.

The overlay is `aria-hidden="true"` and its twistie is a click proxy to the real
header's handler. That is the honesty tax: the real header stays in DOM order,
keeps the accessible name and is the focusable one. A keyboard user forty rows
deep who wants to fold the group they are inside presses ← to jump to the parent
header, which is the workbench's own gesture, so the asymmetry costs nothing in
practice.

**The overlay is a computed value, not a piece of state, and it must stay that
way.** A `state` message can shrink the list while the user is scrolled deep — a
connection deleted from the command palette, a search cleared — leaving
`scrollTop` past the end, `indexAt` clamped to the last item and the overlay
naming the wrong environment. A sticky header that names the wrong environment
is worse than no sticky header at all in a list where environment is the primary
reading. Three rules, all in the same commit that applies the message: rebuild
`geom` first; clamp `scrollTop` to `max(0, offsets[n] − viewportH)` before
anything reads it; and never cache the overlay across a geometry change, so
there is no stale copy to go wrong.

**The ribbons are per group, not per row.** One absolutely-positioned `<div>`
per group inside the spacer, from `offsets[headerIndex]` to the next header's
offset, 3px wide at x=0. Four or five elements whether the list holds twenty
connections or two thousand. Row state rides on `.row.is-live::before` instead,
which resolves a contradiction: environment saturation is a comparison *between
groups* and belongs on a group element where it is uniform; row state is a
comparison *between rows* and belongs on a pseudo-element. Both were on one
channel in the original drawing and they are two different axes.

**One `ResizeObserver`, reading `contentRect.height` only.** It writes
`viewportH`, which changes `last`. It never reads a width, never reads a
computed style, never measures a row, and there are no breakpoint numbers
anywhere in JavaScript. Knowing how tall the viewport is costs one number that
cannot disagree with anything; knowing how wide it is would put a second copy of
the tier table in JavaScript, where it could drift from the stylesheet during a
sash drag.

**Node budget.** At 260px in a 700px sidebar, 28 rows are visible; plus 16
overscan and up to 5 headers the window is about 49 elements. A row is six nodes
at rest and ten while hovered. So roughly **300 nodes, constant**, at 84
connections or 8,400. Per frame: one binary search of seven comparisons, one
transform write, and a reconcile only when the window index actually moves.

**Motion.** Only the `loading` glyph animates, and only on the rows that are
connecting or testing — at most a handful, usually one, because attempts are
user-initiated. The rail transitions `opacity` only, 80ms, never a layout
property. The twistie rotates in 100ms. All of it is zeroed by the
`prefers-reduced-motion` block in `tokens.css`.

## The vertical arithmetic, and what it cost

At a 700px sidebar. The container title bar is 35px, not 22: this is a
single-view container, so the workbench draws the container title and merges the
view's toolbar into it.

```
  700  sidebar
 − 35  workbench container title (not ours)
 ────
  665  webview body
 − 32  search band (never scrolls)
 − 22  footer (never scrolls)
 ────
  611  list viewport
```

Grouped, with a pinned section and four environments: `611 − 5 × 24 = 491`, and
`491 / 22 = 22.3` → **22 connection rows plus 5 sticky headers**. Flat:
`611 / 22 = 27.8` → **27 rows**. With a production session open the footer grows
to 40px: `593 − 120 = 473`, `473 / 22 = 21.5` → **21 rows**. At 170px, identical
— row height does not change with width, which is the point of never growing a
row.

The tree this replaced showed `(665 − 4 × 22) / 22 = 26` rows, and told you the
host but not the state, the database or the environment guard.

**So the new view costs four rows.** What the four rows buy: a search box that
is always on screen, a hover rail, a state readout for the cursor row, a counts
footer, and a production alarm. That is the trade, stated plainly rather than
hidden in a screenshot at 900px. If it is ever judged too expensive, the search
band is the first thing to make collapsible.

## Responsive behaviour

`.sidebar` carries `container-type: inline-size; container-name: rail`, and
every width rule is `@container rail (min-width: …)`. Nothing else participates.
Chromium 114 is the floor and container queries landed in 105, so this is safe;
because a sidebar webview's viewport width *is* the view width, every rule would
work identically as `@media`, and container queries are used only so the same
authoring pattern survives the component being reused elsewhere.

The tiers are derived from content, not from round numbers. Against the
workbench UI font at 13px (about 6.2px average lowercase) and the mono font at
10.5px (about 6.3px): a 12-character name floor is 76px, a four-character badge
is 38px plus a 6px gap, nine characters of a first DNS label is 57px plus an
11px separator, and nine characters of database is 47px plus a separator.

| tier | range | on the row | why there |
|---|---|---|---|
| **xs** | < 196px | name; badge only on failed and production rows | below where a badge and a readable name coexist |
| **sm** | 196–255px | name, badge | 76 + 6 + 38 = 120 ≤ 128 elastic at 196 |
| **md** | 256–311px | name, host, badge | 76 + 11 + 57 + 6 + 38 = 188 ≤ 192 elastic at 260 |
| **lg** | 312–439px | name, host, database, badge | 188 + 11 + 47 = 246 ≤ 252 elastic at 320 |
| **xl** | ≥ 440px | a column grid; badge in a fixed right column | tracks stay generous rather than merely fitting |

**xs.** Host and database leave the row; both are still in the footer readout,
in `title=` and in the accessible name. The badge collapses to zero width for
connected and testing **but not for failed and not for production**. That
asymmetry is deliberate: a connected row already carries three other marks — a
filled disc, a 600-weight name, a bright ribbon tick — so its word is the
cheapest thing to lose, while failure's amber triangle could be mistaken for
UAT's amber by someone who has not learned the vocabulary, and production is
where a missing word costs something. The placeholder shortens to `Filter`, the
rail drops to two buttons, and the group header loses `ENVIRONMENTS[].full`.

**sm.** The badge returns for all four states. This is the biggest legibility
gain per pixel in the system: a state word beats twenty more characters of a
host you already know.

**md — the canonical drawing.** The host returns as its first DNS label, and the
group header adds `ENVIRONMENTS[].full` beside the short badge.

**lg.** The database appears, separated from the host by a 1px × 10px vertical
hairline rather than a middot — at 10.5px a hairline is a lighter mark and gives
the eye a rule to run down instead of a speck to jump over. The group header
gains its guard sentence inline, one line, ellipsised.

**xl.** The elastic run becomes `grid-template-columns: minmax(76px, 1fr) 30% 22%`
and the badge leaves it for a fixed 46px column. Name, host, database and badge
now align into vertical columns across every row: at 500px you are reading
columns rather than rows. At ≥560px a fourth track carries `authLabel(profile)`
right-aligned, and the group header count splits into `18 · 2 open`. Both
`authLabel` and `transportLabel` already exist in `types.ts` and already appeared
in the tree's tooltip, so this promotes existing data out of a hover at no new
data cost.

**The row is still 22px in every tier. Extra width buys extra columns, never
extra rows.** That is the line that does not move.

### The shrink order

Within a tier, every row shows the same fields. If a field is on it is on for
every row, and a long name ellipsises rather than silently evicting its
neighbours — a field that appears on some rows and not others destroys the
vertical scan the whole design is built on.

```
.name      flex: 1 1 auto;  min-width: 76px;  overflow: hidden; text-overflow: ellipsis
.db        flex: 0 1 auto;  min-width: 0;     flex-shrink: 3
.host      flex: 0 1 auto;  min-width: 0;     flex-shrink: 2
.host-head flex: 0 1 auto;  min-width: 4ch;   flex-shrink: 1
.host-tail flex: 0 1 auto;  min-width: 0;     flex-shrink: 6
```

The domain suffix evaporates first, then the database, then the host's first
label, then the name ellipsises. `splitHost` puts the suffix in its own span
precisely so `flex-shrink` can take it while the full string stays in the DOM —
a copy takes the whole host, and the match highlighter can mark a hit inside the
domain. It also drops the port when it equals `defaultPort(driver)`, because
`1433` repeated eighty-four times is not information, and it refuses to split an
IPv4 or IPv6 literal at all. A literal that overflows truncates from the *left*,
because octets differ at the right; a DNS label truncates from the right,
because names differ at the left and it is the family you are scanning for.

Nothing scrolls horizontally at any width. Every text cell is `min-width: 0`
inside its flex or grid track, because a track's automatic minimum is its
content — the same trap `docs/ui-architecture.md` documents for the editor's
`minmax(0, 1fr)`.

### The search-aware override

The arithmetic above says a one-line row cannot carry a database at 260px
without cutting the name to nothing. But search "billing", get a row reading
`orders-write / orders-qa-01`, and you have to hover to find out why it matched.
So the fix is not a breakpoint, it is a rule:

```css
.row[data-hit~="database"] .db   { display: inline !important; flex-shrink: 0 }
.row[data-hit~="host"]     .host { display: inline !important; flex-shrink: 0 }
mark { background: transparent; color: var(--mark); font-weight: 600 }
```

A field the query matched is on the row at every width, including 170px, with
the matched substring marked. When that fires at 170px the name is cut to about
six characters, which is correct: the user is searching, the match is the point,
and the full name is in the readout, the `title=` and the accessible name. A
filter that hides the reason a row matched is the worst scanning failure
available, and this removes it without spending a pixel when nobody is
searching.

## Theme integration

Every neutral surface reads a VS Code theme token, so the panel follows the
user's theme with no theme detection of its own. The environment and engine hues
are the only literals, and each has a light-theme value.

Tokens live in two files. `styles/tokens.css` holds what both surfaces genuinely
share — the four environment hues, the two engine hues, `--radius`, `--gap`,
`--motion`, the `prefers-reduced-motion` block, `.sr-only` and `.mono`. Both
stylesheets `@import './tokens.css'` on line 1 and esbuild inlines it.

**`tokens.css` must not define `--bg`, `--fg`, `--bd` or any other ground
token.** This is not tidiness. `editor.css` defines `--bg:
var(--vscode-editor-background)`; in Dark Modern that is `#1f1f1f` against a
`#181818` sidebar, and in Light Modern `#ffffff` against `#f8f8f8`. A sidebar
that inherited it would paint a visibly lighter rectangle inside the sidebar on
first launch, and every hover scrim would fade to a colour the row underneath is
not. The failure is invisible in a screenshot of one theme and obvious in the
product. If a ground token is ever added to `tokens.css`, someone writes
`var(--bg)` in `sidebar.css`, gets the editor's ground, and the bug comes
straight back. Each surface defines its own ground in its own `:root`.

The sidebar's ground is `--vscode-sideBar-background`, its headers are
`--vscode-sideBarSectionHeader-background`, and its borders are
`--vscode-sideBar-border`. That last group is worth naming: reading the section
header tokens means the group headers render identically to the Explorer's, in
every theme, with zero theme code.

**The `-ink` rule.** Every hue that renders as *text* has an `-ink` variant,
contrast-measured against the sidebar ground in every theme family; every hue
that renders as a *shape* uses the plain token.

| ink token | dark | on `#181818` | light | on `#f8f8f8` |
|---|---|---|---|---|
| `--env-dev-ink` | `#57c76a` | 8.27:1 | `#14682c` | 6.56:1 |
| `--env-qa-ink` | `#6aa9f5` | 7.28:1 | `#0a52ad` | 7.08:1 |
| `--env-uat-ink` | `#e5a054` | 8.02:1 | `#92420a` | 6.65:1 |
| `--env-prod-ink` | `#ff7a66` | 6.96:1 | `#a82d22` | 6.53:1 |
| `--warn-ink` | `#e8b445` | 9.34:1 | `#a35c00` | 4.89:1 |

The environment hues are not routed through `--vscode-charts-*`.
`charts.orange` measures 2.97:1 against Light Modern's sidebar ground, which is
below what a 10.5px badge needs, and a theme may set those tokens to anything.
A value that can be measured beats a value that cannot.

**Four theme branches**: bare `:root`, `body.vscode-light,
body.vscode-high-contrast-light`, `body.vscode-high-contrast`, and
`body.vscode-high-contrast-light`. The third of those does not exist in
`editor.css` today — high-contrast dark currently takes the raw dark literals
with no theme participation at all — and writing it here is half the reason the
token layer was extracted.

**High contrast, both variants.** Every tint in this design is a `color-mix`
against `transparent`, and in high contrast those are at or near invisible. Each
one therefore has a shape twin:

| tint | dies because | replaced by |
|---|---|---|
| ribbon 55% vs 100% | HC flattens perceived opacity | every ribbon goes 3px → 4px and solid; production becomes a 4-on-4-off `repeating-linear-gradient` — a dash pattern rather than a saturation |
| header background | `sideBarSectionHeader-background` may be transparent | `border-block: 1px solid var(--ct)` on every header |
| state badge fill | `--env-prod-ink` ground under light text | outline plus text: `border: 1px solid currentColor; background: transparent`, for every state |
| row separation | there is no row border normally | `.row { border-bottom: 1px solid var(--ct) }` |
| row selection | uses list tokens, so it survives | unchanged, plus `outline: 1px solid var(--ct-active)` |

`--ct` and `--ct-active` are `--vscode-contrastBorder` and
`-contrastActiveBorder` falling back to `transparent`, so those rules resolve to
nothing outside high contrast and one rule serves every theme.

`@media (forced-colors: active)` is a separate mechanism from the two
`body.vscode-high-contrast*` classes and a webview on Windows can hit both at
once, so it gets its own block. Under forced colours the environment hue is
surrendered to the OS entirely: ribbons render `CanvasText` and differ only by
width and dash pattern. That is honest — fighting the OS palette with
`forced-color-adjust: none` on a decorative bar is exactly the thing that makes
a webview look wrong — and the environment is still carried by the sticky
header's short badge, which is text and is always on screen.

Icons are codicons, the workbench's own set, shipped with the extension and
linked from `dist/webview/codicon.css`. The content policy allows no network at
all: no remote script, style, font or fetch.

## Accessibility

**Roles.** The scroller is `role="tree"` with `aria-label="Connections"`.
Section headers are `role="treeitem" aria-level="1" aria-expanded`. Rows are
`role="treeitem" aria-level="2"` when grouped or pinned and `aria-level="1"` in
flat mode. The search band is a `<search>` landmark; the footer is `<footer>`
with `aria-label="Connection counts"`. The sticky overlay is `aria-hidden`.

Because the DOM stops reflecting the list above 120 items, **`aria-setsize` and
`aria-posinset` are set explicitly on every rendered item**, against the full
flattened counts. They are set below the threshold too, so there is one code
path and no state in which they are absent.

**Focus** is a roving tabindex: exactly one element in the tree carries
`tabindex="0"`. The tab order through the panel is search input → the one tree
item → the production band's actions. If the cursor scrolls outside the render
window that row is rendered anyway, at its true offset; when the panel regains
focus after a host round trip, focus returns to the cursor row rather than to
the top.

| key | on a row | on a section header |
|---|---|---|
| `↓` / `↑` | move the cursor one visible item, headers included | same |
| `←` | move to the owning header | collapse if expanded, else move to the previous header |
| `→` | nothing | expand if collapsed, else move to the first child |
| `Home` / `End` | first / last visible item | same |
| `PageDown` / `PageUp` | one viewport of items | same |
| `Enter` | open the connection editor | toggle |
| `Space` | connect if closed, disconnect if open, cancel if in flight | toggle |
| `Delete` | `delete`; the host shows its own modal confirmation | — |
| `Shift+F10`, `ContextMenu` | `menu`; the host's quick pick | — |
| `*` | expand every group | same |
| any printable character | focus moves to the search box and the character is inserted | same |

That last row replaces the workbench's type-ahead-to-select rather than
reimplementing it. There is a real search box on screen; two competing find
mechanisms in one list is worse than one, and the box searches name, host *and*
database where type-ahead would only match a prefix of the name. From the box,
`↓` moves into the list without clearing the query, `Enter` moves to the first
match, and `Escape` clears the query and returns focus to the list.
`Ctrl/Cmd+F` and the title-bar Search action both focus the box and select its
contents.

**Accessible names** are composed exactly the way
`ConnectionTreeItem.accessibilityInformation` composed them — `` `${name},
${environmentLabel(env)}, ${state}` `` — so nothing an assistive-technology user
relies on changes wording, then extended with the fields the row visually
elides:

```
"billing-write, Production, connected, SQL Server,
 sql-prod-01.eu.corp.example.com port 1435, database billing, read-only"
```

`state` is `connected` / `saved, not connected` / `last attempt failed,
<failure>` / `connecting` / `testing`. The two in-flight kinds are kept apart
because `manager.busyKind` distinguishes them and a row that says the wrong one
is a row that lies. Headers read `"Production, 9 connections, 1 open"`. A row
that is connecting or testing carries `aria-busy="true"`; the row the editor is
showing carries `aria-selected="true"`.

**Live regions, and what is deliberately not one.**

- The footer counts are `aria-live="polite"`.
- A new failure fires once through a visually hidden `role="alert"` carrying
  `manager.lastFailure(id)` verbatim.
- The production band is `role="status"` with a *sibling* `sr-only
  role="alert"` that receives its text once on the 0→1 transition and is cleared
  after five seconds. Two elements rather than one whose `role` changes, because
  mutating `role` on a live element is unreliable across screen readers.
- The search result count is a hidden `aria-live="polite"` region debounced to
  500ms — `"12 of 84 connections match"` — because typing must not produce a
  stream of interruptions.
- **The footer readout is `aria-hidden`.** Everything in it is already in the
  row's accessible name, and a region that re-announced on every cursor move
  would be unusable.

**The readout follows the cursor, never the pointer.** Slaving it to hover means
dragging the pointer down eighty-four rows swaps that bar's text eighty-four
times — a strip the eye learns to discount, with the production alarm inside it.
Driving it from the cursor means it changes at click and keypress rate, the
mouse and keyboard paths are identical, hover writes no JavaScript state at all,
and there is no dwell delay to tune. Hover still gets the full string through
`title=`.

**Reduced motion.** `tokens.css` carries `editor.css`'s existing block forward,
which zeroes `--motion` and forces every duration to 0.001ms. That would freeze
the `loading` glyph into a static arc claiming motion it does not have, in the
one state that is about to change — so the busy glyph renders both `loading` and
`sync` and the media query hides one. No JavaScript branch and no media-query
listener, so nothing can disagree with the stylesheet. `aria-busy` is unaffected
either way.

**Colour is never the only carrier.** An environment is a hue, a 3px ribbon
whose width and dash pattern differ under high contrast, a short text badge, a
spelled-out label on the header, a guard sentence, and a position in the list.
A state is a hue, one of four silhouettes chosen to stay separable at 12px in
monochrome — disc, ring, triangle, arc — a word on the row, a word in the
readout, and a word in the accessible name. Print the four state glyphs in black
and you can still name every one; that is the test.

## Files

```
src/shared/sidebar.ts             the host/webview contract, compiled by both
src/ui/connectionsView.ts         the WebviewViewProvider: CSP, nonce, badge,
                                  description, the row's ⋯ quick pick
src/webview/
  state/store.ts                  shared with the editor, unchanged
  primitives/{Codicon,EngineMark}.tsx    reused unchanged
  sidebar/
    index.tsx                     mount
    api.ts                        acquireVsCodeApi typed to the sidebar's union;
                                  scrollTop, the only thing the panel persists
    state.ts                      listStore, sessionStore, cursorStore and the
                                  four stable-selector hooks
    model.ts                      H, FlatItem, heightOf, measure, indexAt,
                                  matchRow, compare, flatten
    host.ts                       splitHost, fullHost, segments
    Sidebar.tsx                   shell, host messages, the keyboard model, focus
    SearchBand.tsx
    VirtualList.tsx               scroller, spacer, ribbons, render window,
                                  the rAF loop, the overlay transform
    StickyHeader.tsx              the aria-hidden overlay and its click proxies
    GroupHeader.tsx               group and pinned headers
    Row.tsx                       StateGlyph, NameRun, StateBadge, ActionRail
    Footer.tsx                    ProductionBand, Counts, Readout
    EmptyState.tsx                the rebuilt viewsWelcome
  styles/tokens.css               the shared hues, radii, motion, .sr-only,
                                  .mono — and no ground token, ever
  styles/sidebar.css              the panel: five @container bands, the
                                  high-contrast and forced-colors blocks
```

`contributes.viewsWelcome` applies only to tree views, so it stopped rendering
the moment the view became `"type": "webview"` and was deleted. `EmptyState.tsx`
is not polish, it is parity: it carries the deleted contribution's copy verbatim
with a full-width primary button posting `{type:'new'}`. `editor.css`'s
`.engine-card` is 272px wide and does not fit a 170px sidebar, so it is not
reused. Launching with zero profiles is a manual check step, because it is the
one state no amount of typing will surface.
