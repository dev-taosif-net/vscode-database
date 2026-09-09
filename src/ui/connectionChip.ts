import * as vscode from 'vscode';
import { ConnectionProfile, EnvironmentId } from '../types';

/**
 * How a connection is drawn in the status bar: a block of the environment's own
 * colour, then the connection, the server and the database.
 *
 * The hues are the four in `webview/styles/tokens.css`, contributed under
 * `databaseTools.statusBarItem.*` so a connection keeps one colour across the
 * sidebar, the connection editor and the strip at the bottom of the window.
 *
 * The block is drawn, not painted, and that is not a stylistic choice. A status
 * bar entry may only take one of two backgrounds, and the extension host drops
 * anything else on the way through without a word — a contributed colour there
 * produces an entry with no fill at all, which is what the first attempt at
 * this got. `color` has no such list, so the environment's hue reaches the
 * strip as ink, and a run of full blocks in that ink is the filled rectangle
 * the fill would have been.
 *
 * Production and UAT are the exception, because for them the two allowed
 * backgrounds exist and say the right thing. They take the real fill and drop
 * the blocks: the workbench overrides `color` whenever a background is set, so
 * blocks there would be repainted to the fill's own ink and vanish into it.
 */
const FILLS: Partial<Record<EnvironmentId, string>> = {
  prod: 'statusBarItem.errorBackground',
  uat: 'statusBarItem.warningBackground'
};

/**
 * Three full blocks, which at the strip's 12px is about as wide as it is tall.
 * U+2588 fills its em box edge to edge, so a run of them closes into one solid
 * rectangle rather than a row of squares.
 *
 * One at each end, not one in front. A leading block is a bullet: the eye reads
 * it as the start of a line and carries on into the text. A pair bounds the
 * label instead, which is the shape a filled entry would have had, and it is
 * the closest the strip gets to the box without a background to paint.
 */
const SWATCH = '███';

/**
 * Put the connection on the entry: text, fill and ink together, because the
 * three only make sense as one decision.
 *
 * The database icon goes with the blocks. It was there to say the entry was
 * ours among a dozen others, and two bounded blocks of a colour nothing else
 * in the strip uses already say it, at the same width.
 */
export function paintChip(item: vscode.StatusBarItem, profile: ConnectionProfile): void {
  const fill = FILLS[profile.environment];
  const label = chipLabel(profile);
  item.text = fill ? `$(database) ${label}` : `${SWATCH} ${label} ${SWATCH}`;
  item.backgroundColor = fill ? new vscode.ThemeColor(fill) : undefined;
  item.color = new vscode.ThemeColor(`databaseTools.statusBarItem.${profile.environment}Foreground`);
}

/** An IPv4 literal. `10.0.4.7` is an address, not a name, and must survive whole. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The server as a strip has room for it: the first label of the host, keeping
 * a named instance because that is the half that tells two of them apart.
 *
 * `sql-prod-01.corp.contoso.com` becomes `sql-prod-01`, and
 * `sql-prod-01.corp\REPORTING` becomes `sql-prod-01\REPORTING`. An address is
 * returned untouched — trimming an IPv4 at its first dot leaves `10`, and an
 * IPv6 literal has no labels to trim. The full host and the port are in the
 * tooltip, which is where a value you have to read character by character
 * belongs.
 */
export function shortServer(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || IPV4.test(trimmed) || trimmed.includes(':')) {
    return trimmed;
  }
  const slash = trimmed.indexOf('\\');
  const address = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const instance = slash === -1 ? '' : trimmed.slice(slash);
  const dot = address.indexOf('.');
  return (dot > 0 ? address.slice(0, dot) : address) + instance;
}

/**
 * Connection, server, database — the three questions asked of the strip, in
 * the order they are asked.
 *
 * A part is dropped when it would say nothing: a profile with no name of its
 * own is named by its server already, and repeating it would spend a third of
 * the entry on one word. A blank database means the server default, which has
 * no name to print.
 */
export function chipLabel(profile: ConnectionProfile): string {
  const server = shortServer(profile.host);
  const name = profile.name.trim();
  const parts = name && name !== server ? [name, server] : [server || profile.host];
  const database = profile.database.trim();
  if (database) {
    parts.push(database);
  }
  return parts.filter(Boolean).join(' · ');
}
