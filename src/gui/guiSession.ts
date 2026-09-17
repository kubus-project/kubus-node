import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SESSION_SECONDS = 12 * 60 * 60;

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(`kubus-gui-session/1:${value}`).digest('base64url');
}

export function guiSessionCookie(secret: string, now = Date.now(), secure = false): string {
  const value = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString('base64url')}`;
  return `kubus_node_gui=${value}.${signature(value, secret)}; Path=/gui; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

export function validGuiSession(value: string, secret: string, now = Date.now()): boolean {
  const match = /^(\d{10})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const remaining = Number(match[1]) - Math.floor(now / 1000);
  if (remaining <= 0 || remaining > SESSION_SECONDS) return false;
  return timingSafeEqual(Buffer.from(match[3]!), Buffer.from(signature(`${match[1]}.${match[2]}`, secret)));
}

export function sameGuiOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site' || !req.headers.origin || !req.headers.host) return false;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host && origin.origin === req.headers.origin;
  } catch { return false; }
}

/** Process-local, bounded and single-use. Restarting invalidates outstanding handoffs. */
export class GuiHandoffs {
  private readonly tickets = new Map<string, number>();
  issue(now = Date.now()): string | undefined {
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket);
    if (this.tickets.size >= 8) return undefined;
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, now + 60_000);
    return ticket;
  }
  consume(ticket: unknown, now = Date.now()): boolean {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expires !== undefined && expires > now;
  }
}
