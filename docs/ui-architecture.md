# Connection editor architecture

The editor is a React application compiled into a VS Code webview. This
document covers what it is made of, how state moves through it, how it borrows
the workbench theme, and what it does for people who do not use a mouse. It is
one of two webviews; the connections sidebar is the other, and
`docs/connections-explorer.md` covers it.

## Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ ● Billing, production                        [Connected]   [ ⋯ ]       │  header
├──────────────────────┬─────────────────────────────────────────────────┤
│ Identity             │ Connection details    ( Manual · String )       │
│                      │  ┌───────────────────────────────────────────┐  │
│ Connection name      │  │ SERVER AND DATABASE                       │  │
│ Environment          │  │  Server ................  Port ....       │  │
│ Server type          │  │  ✓ Resolved to 10.0.1.15, answering       │  │
│                      │  │  Database .............................   │  │
│  320px, fixed        │  ├───────────────────────────────────────────┤  │
│                      │  │ AUTHENTICATION                            │  │
│                      │  │  Method / the fields that method uses     │  │
│                      │  └───────────────────────────────────────────┘  │
│                      │  ▸ Transport  ▸ Network  ▸ Security            │  lazy groups
│                      │  ▸ Session    ▸ Driver                         │
├──────────────────────┴─────────────────────────────────────────────────┤
│ 🔴 PROD Production │ Connecting asks first.  │ server · db · auth · TLS│  summary strip
├────────────────────────────────────────────────────────────────────────┤
│ ✓ Connected in 38 ms · SQL Server 2022 · devuser · Read-write          │  result strip
├────────────────────────────────────────────────────────────────────────┤
│ Cancel                     [Test connection] [Save]        [ Connect ] │  sticky footer
└────────────────────────────────────────────────────────────────────────┘
```

Everything except the details column holds still: the header, identity, the
summary, the result strip and the action bar. The details column
is the only thing that scrolls, so identity stays readable however far down the
form you are, and Connect is always where you left it.

Three rules make that work, and each one replaced a bug.

- The columns row is `minmax(0, 1fr)`, not `1fr`. A grid track's automatic
  minimum is its content, so a plain `1fr` lets a long form push the track past
  the window instead of scrolling inside it.
- The details column is a flex column whose children are `flex: none`. A grid
  item whose overflow is not visible has an automatic minimum size of zero, and
  every panel clips its own corners. As a grid, the tracks were free to shrink:
  a panel needing 607 pixels was handed 84, cut off its own body, and the
  column never overflowed, so it never grew a scrollbar.
- Identity carries an `overflow-y` of its own purely as a safety valve. It
  holds three fields and fits at any ordinary window height, so it never
  scrolls; on a window too short for three fields it scrolls rather than
  cutting the third one off.

Below 940 pixels the two columns stack and identity becomes a responsive grid;
below 720 the padding tightens and the footer wraps; below 520 pixels of height
the whole page scrolls rather than squeezing the form behind a pinned footer.
Nothing scrolls horizontally at any width.

## Component hierarchy

```
index.tsx
└── StoreContext.Provider
    └── App                          host messages, dirty reporting, shortcuts
        ├── EmptyState               when nothing is selected
        └── (editor)
            ├── Header               name, engine, saved/dirty/connected, ⋯ menu
            ├── columns
            │   ├── IdentityPanel    name, environment, server type
            │   └── details
            │       ├── ProductionWarning        only when PROD
            │       ├── Panel "Connection details"
            │       │   ├── Segmented            manual | connection string
            │       │   ├── ServerSection        server, port, probe strip, database
            │       │   ├── AuthSection          only the chosen method's fields
            │       │   └── ConnectionStringPanel
            │       └── Panel "Advanced"
            │           └── AdvancedGroups → Disclosure ×5
            ├── ConnectionSummary    one row: environment left, four facts right
            ├── TestResult
            ├── ActionBar
            └── ProductionConfirm    modal, focus-trapped
```

Primitives under `primitives/` are the vocabulary: `Codicon`, `EngineMark`,
`Button`, `Field`, `TextInput`, `NumberInput`, `SelectInput`, `IconSelect`,
`Checkbox`, `Segmented`, `Disclosure`, `Panel`.

`IconSelect` exists because a native `<select>` cannot draw an icon beside a
choice, and the server type is the one field where the engine's mark says more
than its name. It is the select-only combobox from the ARIA practices: focus
stays on the button, the open list is described through `aria-activedescendant`,
and the arrows, Home, End, Enter, Escape and type-ahead behave the way they do
in a native dropdown. The list is rendered into the body and positioned fixed,
because the column it sits in clips its own overflow and a list opened near the
bottom of it would otherwise be cut in half.

`EngineMark` draws each engine's own mark, in `primitives/logos.tsx`.
Microsoft's SQL Server product icon and the PostgreSQL elephant, both taken
from Wikimedia Commons, the first published there as public domain and the
second under the BSD licence the PostgreSQL project publishes it with. Two
things were changed on the way in: the SQL Server icon lost a rounded-tile clip
and a full-coverage mask, neither of which changed a pixel at these sizes, and
its gradient ids are namespaced per instance with `useId`, because the mark is
rendered five times on one page and an id may appear only once in a document.
They are used to name the product being connected to, which is what they are
for; neither vendor endorses this extension.

## State

One store, subscribed to with selectors.

```
       host                            webview
  ConnectionsPanel  ──state/patch──▶  applyHostMessage ──▶ store
        ▲                                                    │
        └────────── save/test/connect/probe ────── post ◀────┘
```

`state/store.ts` is a fifty-line subscribe-with-a-selector store read through
`useSyncExternalStore`. The alternative, context, would re-render every one of
the roughly eighty controls on each keystroke. Here a control subscribes to the
single field it draws, so typing a server name re-renders the server box, the
summary line and the probe strip, and nothing else.

`AppState` holds the host's last message, the draft being edited, the baseline
the draft is compared against, the typed password kept apart from the profile,
and the editor's own preferences. Transitions are plain functions
(`applyHostMessage`, `setField`, `setMethod`, `toggleGroup`) with no React in
them, which is what makes them testable on their own.

Which method is showing and which advanced groups are open persist through
`vscode.setState`, so they survive a reload of the tab.

## Theme integration

Every neutral surface reads a VS Code theme token, so the page follows the
user's theme, high contrast included, with no theme detection of its own. The
engine and environment hues are the only literals, and each has a light-theme
value. Colour is never the only carrier: an environment is a hue, a short
badge and a sentence naming its guard; a transport state is a hue, an icon and
a word.

Icons are codicons, the workbench's own set, shipped with the extension. The
content policy allows no network at all: no remote script, style, font or
fetch.

## Accessibility

- The segmented control is a real radio group; the disclosures are buttons
  carrying `aria-expanded` and `aria-controls`; the confirmation is an
  `alertdialog` that traps Tab and closes on Escape.
- Both columns and the summary are named landmarks.
- Live readings, the probe strip and the result strip, are polite live regions;
  a failure is an alert.
- Every control has a name, either a `label` or an `aria-label`. Required
  fields are marked in the label, not by colour.
- Decorative icons are `aria-hidden`; an icon carrying meaning has a label.
- `prefers-reduced-motion` removes every transition.

## Files

```
src/shared/protocol.ts          the host/webview contract, compiled by both
src/connections/probe.ts        DNS and TCP reachability, host side
src/webview/
  index.tsx                     mount
  App.tsx                       shell, host messages, shortcuts
  state/{store,editor,vscode}.ts
  lib/connectionString.ts       parse and render, both engines
  primitives/                   Codicon, Button, Field, Inputs, Segmented, …
  components/                   the editor's own parts
  styles/editor.css
```

## Build

`esbuild.mjs` produces five outputs: the extension host bundle for Node, two
webview bundles for the browser with React linked in — this editor and the
connections sidebar — and a stylesheet for each. The two webviews are separate
entry points rather than one shared bundle because the sidebar is resolved on
startup and the editor is not, so sharing would make opening the sidebar pay for
a form nobody has asked for. The codicon font and stylesheet are copied beside
them. React is a dev dependency because it is bundled, so it is never shipped
twice.

`tsconfig.json` covers the host and excludes the webview; `tsconfig.webview.json`
covers the webview with the DOM library and JSX. `npm run typecheck` runs both.
