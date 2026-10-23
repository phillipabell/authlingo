// authlingo core: per-locale Supabase Auth email files -> one Go-template per email type, plus lint.
// No Node imports here, so the Send Email hook (Deno) can reuse the same rules.

/** Supabase Auth email types, as named by the Management API fields mailer_subjects_<type> / mailer_templates_<type>_content. */
export const TYPES = ['confirmation', 'invite', 'magic_link', 'recovery', 'email_change', 'reauthentication'] as const;
export type EmailType = (typeof TYPES)[number];

/** Template variables Supabase Auth documents for its email templates. Others are flagged by lint (warning). */
export const KNOWN_VARS = ['ConfirmationURL', 'Token', 'TokenHash', 'SiteURL', 'RedirectTo', 'Email', 'NewEmail', 'Data'];

export interface LocaleSpec { code: string; match?: string[] }
export interface Config {
  /** user_metadata key holding the locale (rendered as .Data.<key>). Default "locale". */
  localeKey?: string;
  /** locale used when the user's locale is missing or unmatched (the {{ else }} branch) */
  default: string;
  /** locales in branch order. A string is shorthand for { code } matching only itself. */
  locales: (string | LocaleSpec)[];
}
export interface Email { subject: string; body: string }
export type Sources = Record<string, Partial<Record<EmailType, Email>>>;   // locale -> type -> email
export type Compiled = Partial<Record<EmailType, Email>>;

export interface Issue { level: 'error' | 'warn'; locale?: string; type?: EmailType; code: string; msg: string }

export const localeKey = (c: Config) => c.localeKey ?? 'locale';
export function specs(c: Config): Required<LocaleSpec>[] {
  return c.locales.map((l) => (typeof l === 'string' ? { code: l, match: [l] } : { code: l.code, match: l.match ?? [l.code] }));
}

/** A locale file is "Subject: ..." on the first line, a blank line, then the HTML body. */
export function parseEmail(text: string): Email {
  const m = /^Subject:[ \t]*(.*)\r?\n\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('first line must be "Subject: ..."');
  return { subject: m[1].trim(), body: m[2].replace(/\s+$/, '') + '\n' };
}

const goStr = (s: string) => JSON.stringify(s);   // Go and JSON string escapes agree for these printable codes

/** Branch prefix: normalize the locale to a string first. Measured with Go 1.22 text/template: a plain
 *  `eq .Data.locale "fr"` fails ("incompatible types for comparison") when the value is not a string, and
 *  `.Data.locale` fails ("nil pointer") when .Data itself is nil, and a failed render means no email at all. */
const LOCVAR = '$authlingo_locale';
function header(c: Config) {
  return `{{ ${LOCVAR} := "" }}{{ with .Data }}{{ ${LOCVAR} = printf "%v" (or .${localeKey(c)} "") }}{{ end }}`;
}

function branches(c: Config, pick: (code: string) => string): string {
  const others = specs(c).filter((s) => s.code !== c.default);
  let out = '';
  others.forEach((s, i) => {
    out += `{{ ${i === 0 ? 'if' : 'else if'} eq ${LOCVAR} ${s.match.map(goStr).join(' ')} }}${pick(s.code)}`;
  });
  return others.length ? `${out}{{ else }}${pick(c.default)}{{ end }}` : pick(c.default);
}

/** One Go-template per email type: subject and body each get the same locale branches. */
export function compile(c: Config, src: Sources): Compiled {
  const out: Compiled = {};
  for (const t of TYPES) {
    if (!src[c.default]?.[t]) continue;              // a type the default locale does not define is left to Supabase's default
    const get = (code: string, part: keyof Email) => (src[code]?.[t] ?? src[c.default]![t]!)[part];
    out[t] = {
      subject: header(c) + branches(c, (code) => get(code, 'subject')),
      body: header(c) + branches(c, (code) => get(code, 'body')),
    };
  }
  return out;
}

/** Variables used as {{ .Name }} / {{ .Name.x }} / inside other actions, e.g. {{ if .Token }}. */
export function varsOf(s: string): Set<string> {
  const v = new Set<string>();
  for (const a of s.matchAll(/\{\{-?([\s\S]*?)-?\}\}/g)) for (const m of a[1].matchAll(/(?<![\w$])\.([A-Z]\w*)/g)) v.add(m[1]);
  return v;
}

export function lint(c: Config, src: Sources, present: string[] = Object.keys(src)): Issue[] {
  const is: Issue[] = [];
  const all = specs(c);
  const codes = all.map((s) => s.code);
  if (!codes.includes(c.default)) is.push({ level: 'error', code: 'default_not_listed', msg: `default "${c.default}" is not in locales` });
  const seen = new Map<string, string>();
  for (const s of all) for (const m of s.match) {
    if (seen.has(m)) is.push({ level: 'error', locale: s.code, code: 'duplicate_match', msg: `"${m}" also matches ${seen.get(m)}; the first branch wins` });
    else seen.set(m, s.code);
  }
  for (const p of present) if (!codes.includes(p)) is.push({ level: 'warn', locale: p, code: 'unlisted_locale', msg: `folder "${p}" is not in config.locales, so it is never sent` });
  const def = src[c.default] ?? {};
  for (const t of TYPES) {
    const d = def[t];
    for (const code of codes) {
      const e = src[code]?.[t];
      if (!e) {
        if (d && code !== c.default) is.push({ level: 'error', locale: code, type: t, code: 'missing_email', msg: `no ${t} email: users with this locale get the ${c.default} text` });
        continue;
      }
      if (!d) { is.push({ level: 'warn', locale: code, type: t, code: 'no_default', msg: `${t} exists but not in default ${c.default}; it is not compiled` }); continue; }
      if (!e.subject) is.push({ level: 'error', locale: code, type: t, code: 'empty_subject', msg: 'subject is empty' });
      if (!e.body.trim()) is.push({ level: 'error', locale: code, type: t, code: 'empty_body', msg: 'body is empty' });
      const want = varsOf(d.body), have = varsOf(e.body);
      for (const v of want) if (!have.has(v)) is.push({ level: 'error', locale: code, type: t, code: 'missing_var', msg: `body lacks {{ .${v} }} used by ${c.default} (a link or code the user needs)` });
      for (const v of new Set([...have, ...varsOf(e.subject)])) if (!KNOWN_VARS.includes(v)) is.push({ level: 'warn', locale: code, type: t, code: 'unknown_var', msg: `.${v} is not a documented Supabase Auth template variable` });
      const opens = (e.body.match(/\{\{/g) ?? []).length, closes = (e.body.match(/\}\}/g) ?? []).length;
      if (opens !== closes) is.push({ level: 'error', locale: code, type: t, code: 'unbalanced_braces', msg: `${opens} "{{" vs ${closes} "}}"` });
    }
  }
  return is;
}

/** Management API body for PATCH /v1/projects/{ref}/config/auth */
export function managementBody(out: Compiled): Record<string, string> {
  const b: Record<string, string> = {};
  for (const [t, e] of Object.entries(out) as [EmailType, Email][]) {
    b[`mailer_subjects_${t}`] = e.subject;
    b[`mailer_templates_${t}_content`] = e.body;
  }
  return b;
}

/** Pick the locale the compiled template would pick (same normalization and branch order). */
export function pickLocale(c: Config, value: unknown): string {
  const v = value == null || value === '' ? '' : String(value);
  for (const s of specs(c)) if (s.code !== c.default && s.match.includes(v)) return s.code;
  return c.default;
}

/** Minimal renderer for {{ .Var }} and {{ .Data.key }} only (used by the hook). Other actions are left as-is;
 *  lint/build with Go (`authlingo preview`) is the full renderer. */
export function renderSimple(s: string, data: Record<string, unknown>): string {
  return s.replace(/\{\{-?\s*\.([A-Z]\w*)(?:\.(\w+))?\s*-?\}\}/g, (all, k: string, sub?: string) => {
    const v = sub ? (data[k] as Record<string, unknown> | undefined)?.[sub] : data[k];
    return v == null ? '' : escapeHtml(String(v));
  });
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[ch]!);
