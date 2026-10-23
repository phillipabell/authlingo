// authlingo unit tests. Go rendering tests need Go 1.22+ on PATH (skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compile, lint, parseEmail, pickLocale, managementBody, varsOf, renderSimple, type Config, type Sources } from '../src/core.ts';
import { loadProject, goRender, sampleData } from '../src/io.ts';

const hasGo = spawnSync('go', ['version']).status === 0;
const cfg: Config = { default: 'en', locales: ['en', { code: 'fr', match: ['fr', 'fr-CA'] }] };
const src = (): Sources => ({
  en: { recovery: { subject: 'Reset', body: '<a href="{{ .ConfirmationURL }}">Reset</a>\n' } },
  fr: { recovery: { subject: 'Réinitialiser', body: '<a href="{{ .ConfirmationURL }}">Réinitialiser</a>\n' } },
});

test('parseEmail: Subject line, blank line, body', () => {
  assert.deepEqual(parseEmail('Subject: Hi\n\n<p>x</p>\n\n'), { subject: 'Hi', body: '<p>x</p>\n' });
  assert.throws(() => parseEmail('<p>x</p>'), /Subject/);
});

test('lint: clean project has no issues', () => assert.deepEqual(lint(cfg, src()), []));

test('lint: missing email, missing link variable, unknown var, unbalanced, duplicate match, unlisted folder', () => {
  const s = src();
  s.en.confirmation = { subject: 'Confirm', body: '{{ .ConfirmationURL }}' };
  s.fr.recovery = { subject: 'R', body: 'pas de lien {{ .Tokne }} {{' };
  const codes = lint({ ...cfg, locales: [...cfg.locales, { code: 'de', match: ['fr'] }] }, s, ['en', 'fr', 'xx']).map((i) => `${i.locale}/${i.code}`);
  for (const c of ['fr/missing_email', 'fr/missing_var', 'fr/unknown_var', 'fr/unbalanced_braces', 'de/duplicate_match', 'xx/unlisted_locale'])
    assert.ok(codes.includes(c), `${c} in ${codes}`);
});

test('compile: same branch order in subject and body; management field names', () => {
  const out = compile(cfg, src());
  assert.deepEqual(Object.keys(out), ['recovery']);
  assert.match(out.recovery!.subject, /\{\{ if eq \$authlingo_locale "fr" "fr-CA" \}\}Réinitialiser\{\{ else \}\}Reset\{\{ end \}\}$/);
  assert.deepEqual(Object.keys(managementBody(out)), ['mailer_subjects_recovery', 'mailer_templates_recovery_content']);
});

test('pickLocale mirrors the compiled branches', () => {
  assert.equal(pickLocale(cfg, 'fr-CA'), 'fr'); assert.equal(pickLocale(cfg, 'de'), 'en');
  assert.equal(pickLocale(cfg, undefined), 'en'); assert.equal(pickLocale(cfg, 7), 'en');
});

test('varsOf and renderSimple', () => {
  assert.deepEqual([...varsOf('{{ if .Token }}{{ .Token }}{{ end }} {{ .Data.locale }} {{ $x }}')], ['Token', 'Data']);
  assert.equal(renderSimple('<a href="{{ .ConfirmationURL }}">{{ .Data.name }}</a>', { ConfirmationURL: 'https://x/?a=1&b=2', Data: { name: '<b>' } }),
    '<a href="https://x/?a=1&amp;b=2">&lt;b&gt;</a>');
});

test('Go renders the compiled template like pickLocale picks, for odd locale values too', { skip: !hasGo }, () => {
  const out = compile(cfg, src()).recovery!;
  for (const v of ['fr', 'fr-CA', 'en', 'de', '', 7, undefined, true]) {
    const want = pickLocale(cfg, v) === 'fr' ? 'Réinitialiser' : 'Reset';
    assert.equal(goRender(out.subject, sampleData('recovery', v, 'locale'), false), want, `locale=${String(v)}`);
    assert.match(goRender(out.body, sampleData('recovery', v, 'locale'), true), new RegExp(`>${want}</a>`));
  }
  assert.equal(goRender(out.subject, { Data: null }, false), 'Reset');   // nil .Data must not break the email
});

test('the naive workaround fails where the compiled one does not (Go)', { skip: !hasGo }, () => {
  const naive = '{{ if eq .Data.locale "fr" }}FR{{ else }}EN{{ end }}';
  assert.throws(() => goRender(naive, { Data: { locale: 7 } }, false), /incompatible types/);
  assert.throws(() => goRender(naive, { Data: null }, false), /nil pointer/);
});

test('examples project lints clean and every type renders in all locales', { skip: !hasGo }, () => {
  const p = loadProject(new URL('../examples', import.meta.url).pathname);
  assert.deepEqual(lint(p.config, p.sources, p.present), []);
  const out = compile(p.config, p.sources);
  assert.equal(Object.keys(out).length, 5);
  for (const [t, e] of Object.entries(out)) for (const v of ['pl-PL', 'fr', 'en']) {
    const body = goRender(e.body, sampleData(t as never, v, 'locale'), true);
    assert.match(body, /https:\/\/example\.com\/auth\/v1\/verify/, `${t} ${v}`);
  }
});
