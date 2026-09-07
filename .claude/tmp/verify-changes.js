export const meta = {
  name: 'verify-my-changes',
  description: 'Adversarially review the changes made to the extension for regressions in design, behaviour and correctness',
  phases: [
    { title: 'Review', detail: 'one reviewer per changed area, reading the real diff' },
    { title: 'Adjudicate', detail: 'second opinion on each regression claimed' },
  ],
}

const ROOT = 'N:/Lab/vscode-database'

const BASE = `
You are reviewing work in a VS Code extension at ${ROOT}.
Three commits sit on top of a371086. Read the actual diff with:
  git -C ${ROOT} diff a371086..HEAD -- <path>
and read the resulting files in full where you need context.

THE AUTHOR WAS UNDER TWO HARD CONSTRAINTS FROM THE USER:
  1. Do not change the VISUAL DESIGN — no pixel, no layout, no wording a user reads.
  2. Do not change BUSINESS BEHAVIOUR — except where a specific bug was being fixed,
     in which case the change must be exactly the bug fix and nothing more.

Your job is to find where the author BROKE one of those, or introduced a new bug.
Be adversarial and concrete. Read the code, do not assume. A finding with a wrong
line number or a fabricated failure mode is worse than no finding.
Report ONLY real regressions. If an area is clean, return an empty findings array.
`

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          lines: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: {
            type: 'string',
            enum: ['design-regression', 'behaviour-regression', 'new-bug', 'incomplete-fix'],
          },
          evidence: { type: 'string', description: 'the actual code, quoted, and why it is wrong' },
          scenario: { type: 'string', description: 'concrete steps or state that trigger it' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'lines', 'severity', 'category', 'evidence', 'scenario', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const PROBE_TARGET = 'host.trim() + "|" + (port ?? "")'

const AREAS = [
  {
    key: 'drivers',
    prompt: `${BASE}

AREA: the driver changes. git diff a371086..HEAD -- src/drivers src/connections

Four changes to scrutinise:
  1. mssql.ts: certificateHostname moved from options.cryptoCredentialsDetails to options.serverName.
     Verify against node_modules/tedious (18.6.2) that serverName is the right key, that dropping
     cryptoCredentialsDetails entirely loses nothing (what secureContextOptions defaulted to before
     versus now — read connection.js around 808-820), and that the profile.properties override loop
     still runs after it. Does any profile that WORKED before now fail?
  2. mssql.ts connectOnce: an 'errorMessage' listener captures a token; finish() removes it and
     passes it to toDriverError as a fallback. Check: is the listener removed on EVERY settle path
     including abort and success? Can the token come from an unrelated message and so attach a wrong
     number to an unrelated error? Does query()'s one-argument call to toDriverError still behave
     identically? Does errors.ts now classify things it did not before, and is any of that WRONG —
     specifically error 4060 (cannot open database), which also arrives as ELOGIN. Trace what
     describeFailure now returns for 4060 and say whether the user sees a worse message than before.
  3. postgres.ts: the prefer fallback is now gated by answeredOverTls(error). Verify the regex
     against real node-postgres errors. Does 'prefer' still fall back when the server genuinely has
     SSL off? What does node-postgres actually throw there — read node_modules/pg for the
     "does not support SSL" path — and does that error carry a .code? Is 'allow' genuinely untouched?
  4. connectionManager.ts: inFlight is deleted only when it is still this attempt's entry; an aborted
     attempt closes its session and throws abortError(). Check for a leak: if the entry is NOT
     deleted because a newer attempt replaced it, is it ever deleted? Trace two overlapping attempts
     all the way through. Also confirm the removed isBusy() had no caller anywhere.`,
  },
  {
    key: 'store-panel',
    prompt: `${BASE}

AREA: the store and the editor panel. git diff a371086..HEAD -- src/store src/ui

Scrutinise:
  1. connectionStore.ts secret-presence cache. Find a sequence where hasSecret returns a STALE
     answer. Consider: writeSecret failing partway; secrets.onDidChange firing for a profile not yet
     in this.profiles (created in another window); the onDidChange loop returning after the FIRST
     match — is that correct given secretKey is injective? primeSecretPresence swallowing errors;
     presenceReads deleted on both settle paths.
  2. remove(): the order changed — list first, keychain last. Is anything now left inconsistent that
     was consistent before? What if flush() throws?
  3. clamp(): now returns the fallback for null, undefined and empty string. Enumerate EVERY caller
     and say whether any previously-valid value now resolves differently. connectTimeoutSeconds,
     queryTimeoutSeconds — note that 0 is a MEANINGFUL value there, it means no limit — rowsPerFetch
     and sshPort. Does queryTimeoutSeconds 0 still survive normalise? THIS IS THE MOST LIKELY
     REGRESSION IN THE WHOLE DIFF. Check it hard and trace the exact values.
  4. effectiveProfile() now runs normalise() on the patched draft. normalise trims host, database and
     user, and coerces the port. Does that change what Test or Connect does versus before, in a way
     the user would notice? Does normalise drop any field the editor sends in its patch? Read
     normalise line by line and list every field it rewrites.
  5. connectionsPanel: the disposed flag, the send() guard, the busy Set, the onMessage catch, and
     the panel.visible deferral. For the deferral: is there a path where the page never receives a
     state it needs? Consider — panel created and the user switches tab before 'ready' arrives; a
     save completing while hidden; onDidChangeViewState firing for a reason other than visibility.
     Is panel.visible true when the panel sits in a split group that is not focused? Also: the catch
     handler calls this.busy.delete(this.selectedId ?? '') — is that correct when the failing attempt
     was for a DIFFERENT profile than the selected one?`,
  },
  {
    key: 'webview',
    prompt: `${BASE}

AREA: the editor webview. git diff a371086..HEAD -- src/webview

Scrutinise, hunting for VISUAL and BEHAVIOURAL differences:
  1. Header.tsx now reads name and driver instead of the whole draft, and returns null when either is
     undefined. Before it returned null when draft was null. Are those the same condition? Can name
     be undefined while a draft exists? Is the rendered DOM identical in every state?
  2. TestResult.tsx — same question. It now returns null on id === undefined, and the busy branch
     renamed its local port variable to shown. Is the rendered text identical in every branch?
  3. AdvancedGroups.tsx now reads driver, readOnly, propertyCount, strength and label separately.
     Confirm every badge renders exactly as before, including with zero properties and with readOnly
     false. Confirm the transport chip class is unchanged in all three strength states.
  4. editor.ts probe handling: a reply is now dropped unless message.result.target equals the draft's
     ${PROBE_TARGET}. Compare that EXACTLY against how target is built in src/connections/probe.ts
     and in src/webview/components/ServerSection.tsx. Any mismatch makes the probe strip go
     permanently silent, which would be a severe regression. Check the named-instance case, a host
     containing a backslash: probe.ts splits on the backslash for the DNS lookup, but what exactly
     does it put in the target it echoes back? Also check what happens when the host has surrounding
     whitespace, and when port is null.
  5. Field.tsx now provides a React context and gives the hint and error an id. Does adding that id
     change any CSS selector match in editor.css? Does the context provider wrapping {children}
     change the DOM at all? Do aria-required and aria-describedby appear on controls where they
     should not — for instance the Database field's TextInput, inside a Field that is not required?
  6. AuthSection password: an empty box now sets secret to undefined. Does the "Forget the stored
     password" button still work? Is the editor still marked dirty correctly? Is there anything the
     user could do before that they now cannot?
  7. useField now uses useCallback keyed on the field name. Confirm it still returns the same value
     in the same renders, and that no component reads a stale field when key changes.
  8. Check PropertiesTable's EMPTY constant and the ConnectionStringPanel defaultPort swap — is
     defaultPort from types.ts identical to the defaultPortFor it replaced?`,
  },
]

const results = await pipeline(
  AREAS,
  (a) => agent(a.prompt, { label: `review:${a.key}`, phase: 'Review', schema: SCHEMA, effort: 'high' }),
  (r, a) => {
    if (!r || !r.findings || !r.findings.length) return []
    return parallel(
      r.findings.slice(0, 6).map((f) => () =>
        agent(
          `${BASE}

A reviewer claims the author introduced this regression. Decide whether it is REAL.
Read the code yourself. Default to refuted if you cannot reproduce the reasoning from the source.

  title:    ${f.title}
  file:     ${f.file}:${f.lines}
  category: ${f.category}  severity: ${f.severity}
  evidence: ${f.evidence}
  scenario: ${f.scenario}
  proposed fix: ${f.fix}

Also compare against the code BEFORE the change (git -C ${ROOT} show a371086:<path>). If the same
problem existed before, it is not a regression these commits introduced — say so and set preExisting.

Return your verdict.`,
          {
            label: `judge:${a.key}`,
            phase: 'Adjudicate',
            effort: 'high',
            schema: {
              type: 'object',
              properties: {
                refuted: { type: 'boolean' },
                reason: { type: 'string' },
                correctedFix: { type: 'string' },
                preExisting: { type: 'boolean', description: 'true if the problem predates these commits' },
              },
              required: ['refuted', 'reason'],
            },
          }
        ).then((v) => (v ? { ...f, area: a.key, verdict: v } : null))
      )
    )
  }
)

const all = results.flat().filter(Boolean)
const real = all.filter((f) => !f.verdict.refuted)
log(`${real.length} regressions confirmed out of ${all.length} claimed.`)

return {
  regressions: real,
  dismissed: all.filter((f) => f.verdict.refuted).map((f) => ({ title: f.title, reason: f.verdict.reason })),
}
