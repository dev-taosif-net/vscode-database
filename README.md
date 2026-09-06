# Database Tools

Fast, lightweight Microsoft SQL Server and PostgreSQL tooling inside VS Code,
built for large enterprise estates: thousands of objects, many schemas, many
environments. Lazy loading everywhere, aggressive metadata caching, streamed
row-capped fetches, near-zero startup cost.

## Status: phase 1, connections

This release covers everything up to and including an open connection. It does
not run queries yet.

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

Designed and stored on the profile, but not yet acting:

- SSH tunnelling. The details are saved; connections still go direct.
- The read-only flag on SQL Server. PostgreSQL genuinely holds the session
  read-only through `default_transaction_read_only`; SQL Server has no session
  equivalent, so that flag waits for the query gate.
- Fully integrated Windows single sign-on, which needs a native driver.
  NTLM with an explicit domain, user and password works today.
