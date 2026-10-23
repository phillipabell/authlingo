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

Not tested yet (hypotheses):
- A hosted **Free** project accepts the Management API template PATCH (docs show no plan note).
- `.Data` conditionals behave the same on hosted Auth as on self-hosted v2.197.0.
- The hook path works on a new Free project that is blocked from editing templates on the default SMTP (since
  2026-06-03, per Supabase's changelog). The hook needs your own mail provider; authlingo does not send mail itself.
- The hook's renderer handles `{{ .Var }}` and `{{ .Data.key }}` only (other Go actions are passed through as text);
  the template path supports full Go templates. Lint does not yet warn when a body needs the template path.

## Tests

`npm test` (9 tests; Go-dependent ones skip without Go). Self-hosted measurement: `selfhost/` (compose overrides and scripts).

## License

MIT, see `LICENSE`. Not affiliated with or endorsed by Supabase.
