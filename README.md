# authlingo

**Per-locale Supabase Auth email templates, compiled into the one template per email type that Supabase Auth accepts.**

Not affiliated with or endorsed by Supabase.

Supabase Auth has one subject and one body per email type, and no locale setting (upstream issue supabase/auth #80, open
since 2021). The known workaround is hand-written Go-template conditionals on `.Data` (user metadata). authlingo lets
you keep one file per locale and email type, and does the rest:

- `authlingo lint`: missing locale files, a locale body missing a link or code variable the default uses
  (`{{ .ConfirmationURL }}`, `{{ .Token }}`), unknown variables, unbalanced braces, duplicate locale matches, and a
  render of every compiled template with Go's own template engine for every locale plus odd values (missing, empty,
  a number, `.Data` nil).
- `authlingo build`: one subject + one body per type, `management.json` (the Management API fields), `self-hosted.env`,
  and `send-email/` (a complete reference Send Email hook Edge Function).
- `authlingo preview --type recovery --locale fr-CA`: renders with Go `html/template` / `text/template`.
- `authlingo push --project <ref> [--apply]`: `PATCH /v1/projects/<ref>/config/auth` with `mailer_subjects_<type>` and
  `mailer_templates_<type>_content`. Dry run without `--apply`. Token from `SUPABASE_ACCESS_TOKEN`.

About the author's experience: this is a learning and test project. The author has not run Supabase in production.
Every number below is **measured** (with setup stated) unless it is marked **hypothesis**.

Status: v0.1, early, not on npm. Needs Node 22.18+ and Go 1.22+ (lint and preview call Go; `gorender/` is built on first use).

## Layout

```
authlingo.json              {"localeKey": "locale", "default": "en", "locales": ["en", {"code": "fr", "match": ["fr", "fr-CA"]}]}
locales/<code>/<type>.html  first line "Subject: ...", a blank line, then the HTML body
```

Types: `confirmation`, `invite`, `magic_link`, `recovery`, `email_change`, `reauthentication`. The locale is read from
`user_metadata.<localeKey>` (set it at sign-up: `supabase.auth.signUp({ email, password, options: { data: { locale: 'fr-CA' } } })`).
A value no locale matches, or no value, gets the default locale. Matching is exact and case-sensitive (Go templates
have no lowercase function), so list the spellings your app stores in `match`.

What a compiled template starts with, and why:

```
{{ $authlingo_locale := "" }}{{ with .Data }}{{ $authlingo_locale = printf "%v" (or .locale "") }}{{ end }}{{ if eq $authlingo_locale "fr" "fr-CA" }}...{{ else }}...{{ end }}
```

Measured with Go 1.22 (the test suite checks it): the plain workaround `{{ if eq .Data.locale "fr" }}` fails with
"incompatible types for comparison" when the stored value is not a string, and with "nil pointer" when `.Data` is nil.
A failed render means the user gets no email. The prefix turns any value into a string and skips a nil `.Data`.

## Measured on self-hosted Supabase Auth (2026-10-23)

Setup: the official self-hosted stack under Podman in a local VM, Auth (GoTrue) v2.197.0, mail caught by inbucket 3.0.3
(no real mail sent). `examples/` (en, fr with fr-FR/fr-CA, pl with pl-PL; 5 email types). Script: `selfhost/measure.py`.
For each of 5 stored locale values (`"fr-CA"`, `"pl"`, `"de"`, `7`, no key) it triggers signup confirmation, password
recovery, magic link, invite (admin) and email change, then checks the caught mail's subject and body language. Raw:
`results/al-rows-*.json` (template path), `results/al-hook-*.json` (hook path).

| Path | Emails right (subject and body in the expected locale) | Verify links |
|---|---|---|
| Template path: compiled templates via `GOTRUE_MAILER_TEMPLATES_*` URLs + `GOTRUE_MAILER_SUBJECTS_*` | 75 of 75 (3 runs x 25) | link present in all 75 |
| Send Email hook path: `send-email/` on edge-runtime v1.77.4 | 75 of 75 (3 runs x 25) | confirmation links logged the user in, 15 of 15 |

- `.Data` conditionals rendered in **subjects and bodies** on self-hosted Auth, for all 5 types, including the number
  and missing-key cases that break the plain workaround.
- Email change through the hook (`selfhost/email_change_both_links.py`, 1 run): secure email change is on by default, so
  Auth expects two mails. The hook sends the new address the link with `token_hash` and the current address the link
  with `token_hash_new`; clicking both changed the address. Sending only to `user.email` (the first version of the
  hook) delivered nothing to the new address: 0 of 15.
- Self-hosted Auth refuses a plain-http hook URI unless it is localhost ("only localhost, 127.0.0.1, and ::1 are
  supported with http"), so locally the hook runs as a sidecar in Auth's network namespace
  (`selfhost/docker-compose.authlingo-hook.yml`). Hosted projects call an https function URL instead.
- Test tooling note: inbucket's JSON `body.html` field showed UTF-8 bodies as mojibake while the raw message was correct
  UTF-8 quoted-printable; the script parses the raw source.

## Measured on a hosted Free project (2026-10-23)

Setup: an existing Free project on the default email provider (no custom SMTP), Management API with a project-scoped
access token. Everything changed was put back afterwards: the auth config was saved first and restored, and a diff
against the saved copy was empty; the test function, its secret and the test users were deleted.

- **Template path: blocked.** `authlingo push --apply` got `400 Email template modification is not available for free
  tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider.`
  Nothing was changed (0 of 10 fields). On such a project the template path needs custom SMTP.
- **Hook path: works.** Deploying `dist/send-email` through the Management API (`POST .../functions/deploy`, the three
  files, `verify_jwt: false`), setting `SEND_EMAIL_HOOK_SECRET`, and enabling the Send Email hook
  (`hook_send_email_enabled`, `_uri`, `_secrets`) were all accepted on the template-blocked project. Run without
  `SMTP_HOST`, the hook logs what it would send instead of sending (read back from the project's unified logs,
  `source = function_logs`):
  - signup, `locale: "fr-CA"`: locale `fr`, subject "Confirmez votre inscription" (1 of 1);
  - signup, `locale: 7` (a number): default locale `en`, subject "Confirm your signup" (1 of 1).
  The link was in both bodies (HTML-escaped, `&amp;`; the first version of the log check missed that and logged
  `body_has_link: false`, fixed since and checked against a local render).
- **Rate limit:** the third signup (no locale key) got `429 over_email_send_rate_limit`. The default provider's limit of
  2 emails per hour applied even though the hook sent nothing itself.

Not tested on hosted (hypotheses or self-hosted only):
- No locale key, recovery, magic link, invite and email change through the hook (blocked by the 2/hour limit; all
  measured on self-hosted above).
- `.Data` conditionals in the template path on hosted Auth (blocked without custom SMTP).
- Actual delivery through a mail provider from the hook (no paid sender used; delivery measured on self-hosted only).
- The hook's renderer handles `{{ .Var }}` and `{{ .Data.key }}` only (other Go actions are passed through as text);
  the template path supports full Go templates. Lint does not yet warn when a body needs the template path.

## Supabase Free plan limits (measured)

Measured 2026-10-23 on a hosted Free project, default email provider, no custom SMTP (full setup and raw numbers
above under "Measured on a hosted Free project"):

- **Template path returns 400.** `PATCH /v1/projects/<ref>/config/auth` with `mailer_subjects_*`/`mailer_templates_*`
  content got `400 Email template modification is not available for free tier projects using the default email
  provider.` Custom templates need custom SMTP or the Send Email hook.
- **Default provider rate limit: about 2 emails then 429.** Two signups sent; the third got
  `429 over_email_send_rate_limit`. This is the provider's limit (per project, observed as roughly 2/hour), not
  something authlingo or the hook controls, and it applies even when the hook only logs instead of sending.
- **Send Email hook deploys and runs on the same template-blocked project** (function deploy, hook secret, and
  `hook_send_email_enabled` all accepted). Without `SMTP_HOST` set it logs what it would send instead of sending,
  which is how locale picking was checked without hitting the rate limit.

Anything not listed here (e.g. actual hosted delivery through a mail provider) was not measured on hosted; see the
measured sections above for what is self-hosted-only vs. a hypothesis.

## Send Email hook (reference)

`authlingo build` writes a complete Send Email hook Edge Function to `dist/send-email/` (the same code lives in this
repo under `hook/send-email/` for reading without building). It is a **copy-paste reference**, not a published
package: deploy it yourself with `supabase functions deploy send-email --no-verify-jwt`, then set
`SEND_EMAIL_HOOK_SECRET` and point the project's Send Email hook at it. Without `SMTP_HOST` set it only logs what it
would send (useful for checking locale picking before wiring a mail provider):

```ts
// hook/send-email/index.ts (excerpt) - verify the signature, pick the locale, render, send or log
const { user, email_data } = new Webhook(secret).verify(payload, Object.fromEntries(req.headers));
const locale = pickLocale(config, user.user_metadata?.[config.localeKey ?? 'locale']);
const e = sources[locale]?.[type] ?? sources[config.default]?.[type];
const subject = renderSimple(e.subject, data), html = renderSimple(e.body, data);
if (capture) { console.log(JSON.stringify({ authlingo_capture: true, subject, locale })); }
else { await transport.sendMail({ to, subject, html, ... }); }
```

See `hook/send-email/index.ts` and `hook/send-email/core.ts` for the full, working version.

## Tests

`npm test` (9 tests; Go-dependent ones skip without Go). Self-hosted measurement: `selfhost/` (compose overrides and scripts).

## License

MIT, see `LICENSE`. Not affiliated with or endorsed by Supabase.
