import { ConnectionRow } from '../../shared/sidebar';
import { defaultPort } from '../../types';

export interface HostParts {
  /** The first DNS label, or the whole literal for an address. */
  head: string;
  /** The domain suffix. Rendered, but the first thing flex-shrink evaporates. */
  tail: string;
  /** `:1435`, or empty when the port is the driver's default. */
  port: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The domain suffix is constant across almost every row in an enterprise
 * estate — twenty characters of `.eu.corp.example.com` repeated down sixty of
 * eighty-four rows is pure redundancy — while the first label is where the
 * entropy lives. So the tail is rendered but given away first, and the port is
 * drawn only when it is not the driver's default, because `1433` repeated
 * eighty-four times is not information. This is what makes a four-field
 * one-line row possible at all.
 */
export function splitHost(row: ConnectionRow): HostParts {
  const host = row.host || 'no host';
  const port = row.port !== null && row.port !== defaultPort(row.driver) ? `:${row.port}` : '';
  // An IPv6 literal is all colons, and an IPv4 literal differs at its right
  // end, so neither may be split or lose a suffix.
  if (IPV4.test(host) || host.includes(':') || !host.includes('.')) {
    return { head: host, tail: '', port };
  }
  const dot = host.indexOf('.');
  return { head: host.slice(0, dot), tail: host.slice(dot), port };
}

/** The whole address, for a tooltip, the readout and the clipboard. */
export function fullHost(row: ConnectionRow): string {
  const host = row.host || 'no host';
  return row.port === null ? host : `${host}:${row.port}`;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Splits a field into runs so the matched part can be marked. */
export function segments(text: string, needle: string): Segment[] {
  if (!needle) {
    return [{ text, hit: false }];
  }
  const out: Segment[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (;;) {
    const found = lower.indexOf(needle, at);
    if (found < 0) {
      break;
    }
    if (found > at) {
      out.push({ text: text.slice(at, found), hit: false });
    }
    out.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
  }
  if (at < text.length) {
    out.push({ text: text.slice(at), hit: false });
  }
  return out.length > 0 ? out : [{ text, hit: false }];
}
