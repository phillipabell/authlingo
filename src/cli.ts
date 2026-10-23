#!/usr/bin/env node
// authlingo: per-locale Supabase Auth emails -> one Go-template per email type.
//   authlingo lint    [dir]                         errors exit 1
//   authlingo build   [dir] [--out dist]            compiled templates, management.json, self-hosted.env, send-email/ hook
//   authlingo preview [dir] --type T [--locale fr]  render subject + body with Go (the engine Supabase Auth uses)
//   authlingo push    [dir] --project REF [--apply] PATCH /v1/projects/REF/config/auth (dry run without --apply)
//                     token from SUPABASE_ACCESS_TOKEN (a personal access token; never commit it)
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, lint, managementBody, localeKey, TYPES, type EmailType, type Issue } from './core.ts';
import { loadProject, goRender, sampleData, pushManagement } from './io.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const die = (m: string, code = 2): never => { console.error(m); process.exit(code); };

const cmd = args.shift();
const out = opt('--out') ?? 'dist', type = opt('--type'), loc = opt('--locale'), ref = opt('--project'), apply = flag('--apply');
const dir = args[0] ?? '.';
if (!cmd || !['lint', 'build', 'preview', 'push'].includes(cmd)) die('usage: authlingo lint|build|preview|push [dir] (see src/cli.ts header)');

const p = loadProject(dir);
const issues = lint(p.config, p.sources, p.present);
const show = (is: Issue[]) => { for (const i of is) console.error(`${i.level.toUpperCase()} ${[i.locale, i.type].filter(Boolean).join('/')} ${i.code}: ${i.msg}`); };
const errors = issues.filter((i) => i.level === 'error');
const compiled = compile(p.config, p.sources);

/** Every compiled template must parse and render in Go, for every locale and for missing/odd locale values. */
function goCheck(): string[] {
  const bad: string[] = [];
  const values: unknown[] = [undefined, '', 7, ...p.config.locales.map((l) => (typeof l === 'string' ? l : l.code))];
  for (const [t, e] of Object.entries(compiled)) for (const v of values) {
    const d = sampleData(t as EmailType, v, localeKey(p.config));
    for (const [part, html] of [['subject', false], ['body', true]] as const) {
      try { goRender(e[part], d, html); } catch (err) { bad.push(`${t} ${part} locale=${JSON.stringify(v)}: ${(err as Error).message}`); }
    }
    try { goRender(e.body, { ...sampleData(t as EmailType, undefined, ''), Data: null }, true); } catch (err) { bad.push(`${t} body Data=null: ${(err as Error).message}`); }
  }
  return bad;
}

if (cmd === 'lint') {
  show(issues);
  const bad = goCheck(); for (const b of bad) console.error(`ERROR go_render ${b}`);
  console.error(`${errors.length + bad.length} error(s), ${issues.length - errors.length} warning(s)`);
  process.exit(errors.length + bad.length ? 1 : 0);
}
if (errors.length) { show(issues); die('lint errors: fix them first (authlingo lint)', 1); }

if (cmd === 'build') {
  mkdirSync(out, { recursive: true });
  const env: string[] = [];
  for (const [t, e] of Object.entries(compiled)) {
    writeFileSync(join(out, `${t}.subject.txt`), e.subject);
    writeFileSync(join(out, `${t}.html`), e.body);
    env.push(`GOTRUE_MAILER_SUBJECTS_${t.toUpperCase()}=${JSON.stringify(e.subject)}`,
      `GOTRUE_MAILER_TEMPLATES_${t.toUpperCase()}=<URL serving ${t}.html>`);
  }
  writeFileSync(join(out, 'management.json'), JSON.stringify(managementBody(compiled), null, 1));
  const hook = join(out, 'send-email'), here = dirname(fileURLToPath(import.meta.url));
  mkdirSync(hook, { recursive: true });
  writeFileSync(join(hook, 'hook-templates.json'), JSON.stringify({ config: p.config, sources: p.sources }, null, 1));
  copyFileSync(join(here, 'core.ts'), join(hook, 'core.ts'));
  copyFileSync(join(here, '..', 'hook', 'send-email', 'index.ts'), join(hook, 'index.ts'));
  writeFileSync(join(out, 'self-hosted.env'), env.join('\n') + '\n');
  console.error(`built ${Object.keys(compiled).length} email type(s) x ${p.config.locales.length} locale(s) into ${out}/`);
}
if (cmd === 'preview') {
  if (!type || !TYPES.includes(type as EmailType)) die(`--type one of ${TYPES.join(', ')}`);
  const e = compiled[type as EmailType] ?? die(`no ${type} email in the default locale`);
  const d = sampleData(type as EmailType, loc, localeKey(p.config));
  console.log(`Subject: ${goRender(e.subject, d, false)}\n\n${goRender(e.body, d, true)}`);
}
if (cmd === 'push') {
  if (!ref) die('--project <ref> required');
  const body = managementBody(compiled);
  if (!apply) { console.log(JSON.stringify(body, null, 1)); console.error(`dry run: ${Object.keys(body).length} field(s); add --apply to send`); }
  else {
    const token = process.env.SUPABASE_ACCESS_TOKEN ?? die('set SUPABASE_ACCESS_TOKEN');
    await pushManagement(ref!, token, body, process.env.AUTHLINGO_API_BASE);
    console.error(`pushed ${Object.keys(body).length} field(s) to project ${ref}`);
  }
}
