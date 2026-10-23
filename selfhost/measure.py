# runs inside the supabase VM: drives self-hosted Auth, reads the caught mail from inbucket
import json, os, re, time, urllib.request, uuid
envf = dict(l.split('=', 1) for l in open(os.path.expanduser('~/supabase/.env')).read().splitlines() if '=' in l and not l.startswith('#'))
A, S, U = envf['ANON_KEY'].strip('"'), envf['SERVICE_ROLE_KEY'].strip('"'), 'http://127.0.0.1:8000/auth/v1'
def call(method, path, body=None, key=A, bearer=None):
    r = urllib.request.Request(U + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'apikey': key, 'Authorization': 'Bearer ' + (bearer or key), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r) as f: return f.status, json.loads(f.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:200]
def mail(box, n=1, wait=10):
    for _ in range(wait * 4):
        with urllib.request.urlopen(f'http://127.0.0.1:9000/api/v1/mailbox/{box}') as f: lst = json.loads(f.read())
        if len(lst) >= n:
            m = lst[n - 1]
            # parse the raw MIME source: inbucket's JSON body field showed UTF-8 bodies as mojibake (raw mail was fine)
            with urllib.request.urlopen(f'http://127.0.0.1:9000/api/v1/mailbox/{box}/{m["id"]}/source') as f: raw = f.read()
            import email, email.policy
            msg = email.message_from_bytes(raw, policy=email.policy.default)
            part = msg.get_body(('html', 'plain'))
            mail.via = 'hook' if msg['Content-Language'] else 'template'
            return str(msg['subject']), part.get_content() if part else ''
        time.sleep(0.25)
    return None, None
SUBJ = {'confirmation': {'fr': 'Confirmez votre inscription', 'pl': 'Potwierdź rejestrację', 'en': 'Confirm your signup'},
        'recovery': {'fr': 'Réinitialisez votre mot de passe', 'pl': 'Zresetuj hasło', 'en': 'Reset your password'},
        'magic_link': {'fr': 'Votre lien de connexion', 'pl': 'Twój link do logowania', 'en': 'Your sign-in link'},
        'invite': {'fr': 'Vous êtes invité', 'pl': 'Zaproszenie', 'en': 'You have been invited'},
        'email_change': {'fr': 'Confirmez votre nouvelle adresse', 'pl': 'Potwierdź nowy adres e-mail', 'en': 'Confirm your new email'}}
BODY = {'fr': 'Suivez|Connexion|Réinitialisation|Vous êtes invité|Confirmez le changement', 'pl': 'Kliknij|Logowanie|Reset hasła|Zaproszono|Potwierdź zmianę', 'en': 'Follow this link|Sign in|Reset your password|You have been invited|Confirm the change'}
cases = [('fr-CA', 'fr'), ('pl', 'pl'), ('de', 'en'), (7, 'en'), ('MISSING', 'en')]
rows = []
for val, want in cases:
    meta = {} if val == 'MISSING' else {'locale': val}
    tag = uuid.uuid4().hex[:8]
    def row(t, box, n, status):
        s, b = mail(box, n)
        got = next((l for l, v in SUBJ[t].items() if v == s), None)
        bl = next((l for l, v in BODY.items() if b and re.search(v, b)), None)
        link_ok = None
        if t in ('confirmation', 'email_change') and b:
            m = re.search(r'href="([^"]+/auth/v1/verify\?[^"]+)"', b)
            if m:
                class NoRedir(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, *a, **k): return None
                u = m.group(1).replace('&amp;', '&').replace('http://localhost:8000', 'http://127.0.0.1:8000')
                try: urllib.request.build_opener(NoRedir).open(u); link_ok = False
                except urllib.error.HTTPError as e: link_ok = e.code in (302, 303) and 'access_token=' in (e.headers.get('Location') or ''); mail.loc = (e.headers.get('Location') or '')[-120:]
        rows.append({'type': t, 'via': getattr(mail, 'via', None), 'link_ok': link_ok, 'loc': getattr(mail, 'loc', None) if t == 'email_change' else None, 'locale_value': val, 'want': want, 'http': status, 'subject_locale': got, 'body_locale': bl,
                     'subject': s, 'has_link': bool(b and '/auth/v1/verify?token=' in b), 'ok': got == want and bl == want})
    e = f'c{tag}@example.com'; st, _ = call('POST', '/signup', {'email': e, 'password': 'Pw-' + tag + '!x', 'data': meta}); row('confirmation', e.split('@')[0], 1, st)
    time.sleep(1.5); st, _ = call('POST', '/recover', {'email': e}); row('recovery', e.split('@')[0], 2, st)
    i = f'i{tag}@example.com'; st, _ = call('POST', '/invite', {'email': i, 'data': meta}, key=S); row('invite', i.split('@')[0], 1, st)
    x = f'x{tag}@example.com'; call('POST', '/admin/users', {'email': x, 'password': 'Pw-' + tag + '!x', 'email_confirm': True, 'user_metadata': meta}, key=S)
    st, _ = call('POST', '/otp', {'email': x, 'create_user': False}); row('magic_link', x.split('@')[0], 1, st)
    time.sleep(1.5)
    st, tok = call('POST', '/token?grant_type=password', {'email': x, 'password': 'Pw-' + tag + '!x'})
    n = f'n{tag}@example.com'; st, _ = call('PUT', '/user', {'email': n}, bearer=tok.get('access_token') if isinstance(tok, dict) else None); row('email_change', n.split('@')[0], 1, st)
print(json.dumps(rows))
