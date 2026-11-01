import { createHash } from 'node:crypto';
import { existsSync, realpathSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path';

export const now = (): string => new Date().toISOString();
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export class HarnessError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function workspacePath(root: string, raw: string): string {
  if (raw.startsWith('~') || raw.includes('\0') || (process.platform === 'win32' && /[:]/.test(raw.replace(/^[A-Za-z]:/, '')))) {
    throw new HarnessError('scope_denied', 'Unsupported workspace path');
  }
  const target = resolve(root, raw);
  if (!inside(root, target)) throw new HarnessError('scope_denied', 'Path is outside the task workspace');
  let ancestor = target;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
  try {
    if (!inside(root, realpathSync(ancestor))) throw new Error('Outside workspace');
  } catch { throw new HarnessError('scope_denied', 'Path resolves outside the workspace or through an unresolved link'); }
  return target;
}
export function snapshot(root: string): { digest: string; files: Array<{ path: string; sha256: string; bytes: number }> } {
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  let bytes = 0;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) throw new HarnessError('snapshot_error', 'Workspace snapshots do not support symbolic links');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const size = lstatSync(path).size;
        bytes += size;
        if (files.length >= 5000 || bytes > 32 * 1024 * 1024) throw new HarnessError('snapshot_error', 'Workspace snapshot exceeds 5000 files or 32 MiB');
        files.push({ path: relative(root, path), sha256: digest(readFileSync(path)), bytes: size });
      }
    }
  }
  walk(root);
  return { digest: digest(JSON.stringify(files)), files };
}
export function sanitize(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 10) return '[depth limited]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]');
    return text.length > 4096 ? `${text.slice(0, 4096)}[truncated]` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitize(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key,
      /^(authorization|password|secret|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key) ? '[redacted]' : sanitize(item, secrets, depth + 1)]));
  }
  return value;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export const terminal = (status: string): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);


/** Stable JSON for approval bindings. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Approval binding contains a non-JSON value');
  return encoded;
}
