import { lookup } from 'node:dns/promises';
import { Socket } from 'node:net';
import { ProbeResult } from '../shared/protocol';
import { DriverKind, defaultPort } from '../types';

const CONNECT_TIMEOUT_MS = 2500;

/**
 * A cheap look at whether an address is worth trying: does the name resolve,
 * and does anything answer on the port.
 *
 * It opens a TCP socket and closes it again without saying a word, so it
 * cannot authenticate, cannot log in, and leaves nothing on the server. It
 * exists so a typo in a host name is caught while it is being typed rather
 * than thirty seconds into a driver timeout.
 */
export async function probeServer(
  rawHost: string,
  rawPort: number | null,
  driver: DriverKind
): Promise<ProbeResult> {
  // A named instance carries the instance after a backslash, and the browser
  // service, not the instance, is what listens on the port.
  const host = rawHost.trim().split('\\')[0].trim();
  const port = rawPort ?? defaultPort(driver);
  const target = `${rawHost.trim()}|${rawPort ?? ''}`;

  if (!host) {
    return { target, state: 'idle' };
  }

  let address: string;
  try {
    const resolved = await lookup(host);
    address = resolved.address;
  } catch {
    return {
      target,
      state: 'unresolved',
      message: `${host} does not resolve. Check the spelling, the search domain, or the VPN.`
    };
  }

  const started = Date.now();
  const reachable = await canReach(address, port);
  const latencyMs = Date.now() - started;

  if (!reachable) {
    return {
      target,
      state: 'unreachable',
      address,
      message: `${address} resolved, but nothing answered on ${port}. Check the port, the firewall, or whether the service is running.`
    };
  }

  return { target, state: 'reachable', address, latencyMs };
}

function canReach(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, address);
  });
}
