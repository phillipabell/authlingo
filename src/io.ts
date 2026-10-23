// Node side: read a project folder, render with Go, push to the Management API.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TYPES, parseEmail, type Config, type Sources, type EmailType, type Compiled } from './core.ts';

/** <dir>/authlingo.json + <dir>/locales/<code>/<type>.html */
export function loadProject(dir: string): { config: Config; sources: Sources; present: string[] } {
  const config = JSON.parse(readFileSync(join(dir, 'authlingo.json'), 'utf8')) as Config;
  const ld = join(dir, 'locales');
  const present = readdirSync(ld).filter((d) => statSync(join(ld, d)).isDirectory());
  const sources: Sources = {};
  for (const code of present) {
    sources[code] = {};
    for (const t of TYPES) {
      const f = join(ld, code, `${t}.html`);
      if (!existsSync(f)) continue;
      try { sources[code][t] = parseEmail(readFileSync(f, 'utf8')); }
      catch (e) { throw new Error(`${f}: ${(e as Error).message}`); }
    }
  }
  return { config, sources, present };
}

const GOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'gorender');
let bin: string | undefined;
/** Path to the Go renderer, built once into gorender/gorender (needs Go 1.22+ on PATH). */
export function goRenderer(): string {
  if (bin) return bin;
  const b = join(GOR, 'gorender');
  if (!existsSync(b)) execFileSync('go', ['build', '-o', 'gorender', '.'], { cwd: GOR, stdio: 'inherit' });
  return (bin = b);
}

/** Render with Go's html/template (html: true, email bodies) or text/template (subjects). Throws Go's error. */
export function goRender(template: string, data: Record<string, unknown>, html: boolean): string {
  const r = spawnSync(goRenderer(), { input: JSON.stringify({ template, data, html }), encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || 'gorender failed').trim());
  return r.stdout;
}

/** Sample values for preview, close to what Supabase Auth passes. */
export function sampleData(type: EmailType, locale: unknown, localeKey: string): Record<string, unknown> {
  const site = 'https://example.com';
  return { SiteURL: site, Email: 'user@example.com', NewEmail: 'new@example.com', Token: '123456', TokenHash: 'abc123hash',
    RedirectTo: site + '/welcome', ConfirmationURL: `${site}/auth/v1/verify?token=abc123hash&type=${type}&redirect_to=${site}`,
    Data: locale === undefined ? {} : { [localeKey]: locale } };
}

export async function pushManagement(ref: string, token: string, body: Record<string, string>, base = 'https://api.supabase.com') {
  const res = await fetch(`${base}/v1/projects/${encodeURIComponent(ref)}/config/auth`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export type { Compiled };
