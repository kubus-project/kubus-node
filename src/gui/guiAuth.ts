import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/schema.js';

export function isLoopbackRemote(address?: string | null): boolean {
  const normalized = (address || '').toLowerCase();
  return normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost';
}

export function guiRemoteMode(config: AppConfig): boolean {
  const host = config.guiHost.trim().toLowerCase();
  return config.guiAllowRemote || !['127.0.0.1', '::1', 'localhost'].includes(host);
}

export function assertGuiConfig(config: AppConfig): void {
  if (guiRemoteMode(config) && !config.guiToken) {
    throw new Error('NODE_GUI_TOKEN is required when the GUI is exposed beyond localhost');
  }
}

export function authorizeGuiRequest(req: IncomingMessage, config: AppConfig): boolean {
  const remoteIsLoopback = isLoopbackRemote(req.socket.remoteAddress);
  if (!config.guiToken) return remoteIsLoopback && !guiRemoteMode(config);
  const header = req.headers.authorization || '';
  if (header === `Bearer ${config.guiToken}`) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((part) => part.trim() === `kubus_node_gui=${encodeURIComponent(config.guiToken || '')}`);
}

export function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ success: false, error: 'GUI authorization required' }));
}
