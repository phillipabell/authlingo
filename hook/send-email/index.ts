// Reference Send Email Auth Hook (Supabase Edge Function, Deno) that sends locale-aware auth emails.
// For projects that cannot edit templates (new Free projects on the default SMTP since 2026-06-03): Supabase Auth
// calls this hook instead of sending mail itself, so the hook picks the locale and sends through YOUR mail provider.
// `authlingo build` writes this folder complete into dist/send-email/ (index.ts + core.ts + hook-templates.json).
// Env (function secrets): SEND_EMAIL_HOOK_SECRET ("v1,whsec_..."), SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// SMTP_FROM, optional SUPABASE_URL (default: the site_url in the payload is used to build the verify link).
import { Webhook } from 'npm:standardwebhooks@1.0.0';
import nodemailer from 'npm:nodemailer@6.9.16';
import { pickLocale, renderSimple, type Config, type Sources, type EmailType } from './core.ts';
import bundle from './hook-templates.json' with { type: 'json' };

const { config, sources } = bundle as unknown as { config: Config; sources: Sources };

/** email_action_type from the hook payload -> template type */
const ACTION: Record<string, EmailType> = {
  signup: 'confirmation', invite: 'invite', magiclink: 'magic_link', email: 'magic_link', recovery: 'recovery',
  email_change: 'email_change', email_change_new: 'email_change', reauthentication: 'reauthentication',
};

const env = (k: string, d?: string) => Deno.env.get(k) ?? d ?? '';
const transport = nodemailer.createTransport({
  host: env('SMTP_HOST'), port: Number(env('SMTP_PORT', '587')), secure: env('SMTP_PORT') === '465',
  auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
});

Deno.serve(async (req) => {
  const payload = await req.text();
  const secret = env('SEND_EMAIL_HOOK_SECRET').replace(/^v1,whsec_/, '');
  let user: any, email_data: any;
  try { ({ user, email_data } = new Webhook(secret).verify(payload, Object.fromEntries(req.headers)) as any); }
  catch { return json(401, { error: { http_code: 401, message: 'invalid signature' } }); }

  const type = ACTION[email_data.email_action_type];
  const locale = pickLocale(config, user.user_metadata?.[config.localeKey ?? 'locale']);
  const e = type && (sources[locale]?.[type] ?? sources[config.default]?.[type]);
  if (!e) return json(400, { error: { http_code: 400, message: `no template for ${email_data.email_action_type}` } });

  const base = env('SUPABASE_URL') ? `${env('SUPABASE_URL')}/auth/v1` : email_data.site_url;
  const link = (hash: string) => `${base}/verify?token=${encodeURIComponent(hash)}&type=${encodeURIComponent(email_data.email_action_type)}` +
    `&redirect_to=${encodeURIComponent(email_data.redirect_to ?? '')}`;
  // Email change sends to the NEW address; with secure email change on, the payload also carries a second token
  // and the CURRENT address gets its own mail. Measured on self-hosted Auth v2.197.0: token_hash goes with the new
  // address and token_hash_new with the current one (the names look swapped; the docs warn about this).
  const sends: { to: string; hash: string; token: string }[] = type === 'email_change'
    ? [{ to: user.new_email, hash: email_data.token_hash, token: email_data.token },
       ...(email_data.token_hash_new ? [{ to: user.email, hash: email_data.token_hash_new, token: email_data.token_new }] : [])]
    : [{ to: user.email, hash: email_data.token_hash, token: email_data.token }];
  try {
    for (const s of sends) {
      const data = { ConfirmationURL: link(s.hash), Token: s.token, TokenHash: s.hash, SiteURL: email_data.site_url,
        RedirectTo: email_data.redirect_to, Email: user.email, NewEmail: user.new_email, Data: user.user_metadata ?? {} };
      await transport.sendMail({ from: env('SMTP_FROM'), to: s.to, subject: renderSimple(e.subject, data).replace(/[\r\n]+/g, ' '),
        html: renderSimple(e.body, data), headers: { 'Content-Language': locale } });
    }
  } catch (err) {
    return json(500, { error: { http_code: 500, message: `send failed: ${(err as Error).message}` } });
  }
  return json(200, {});
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
