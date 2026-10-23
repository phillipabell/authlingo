# email change via the hook: click the link in BOTH mails, check the address actually changed
import json, os, re, time, urllib.request, uuid, email, email.policy
envf = dict(l.split('=', 1) for l in open(os.path.expanduser('~/supabase/.env')).read().splitlines() if '=' in l and not l.startswith('#'))
A, S, U = envf['ANON_KEY'].strip('"'), envf['SERVICE_ROLE_KEY'].strip('"'), 'http://127.0.0.1:8000/auth/v1'
def call(m, p, b=None, key=A, bearer=None):
    r = urllib.request.Request(U + p, method=m, data=json.dumps(b).encode() if b is not None else None,
        headers={'apikey': key, 'Authorization': 'Bearer ' + (bearer or key), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(r) as f: return json.loads(f.read() or b'{}')
def body(box):
    for _ in range(40):
        l = json.loads(urllib.request.urlopen(f'http://127.0.0.1:9000/api/v1/mailbox/{box}').read())
        if l: break
        time.sleep(0.25)
    raw = urllib.request.urlopen(f'http://127.0.0.1:9000/api/v1/mailbox/{box}/{l[-1]["id"]}/source').read()
    return email.message_from_bytes(raw, policy=email.policy.default).get_body(('html',)).get_content()
class NoRedir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
def click(b):
    u = re.search(r'href="([^"]+/auth/v1/verify\?[^"]+)"', b).group(1).replace('&amp;', '&').replace('http://localhost:8000', 'http://127.0.0.1:8000')
    try: urllib.request.build_opener(NoRedir).open(u)
    except urllib.error.HTTPError as e: return urllib.parse.unquote_plus(e.headers.get('Location', ''))[-90:]
import urllib.parse
t = uuid.uuid4().hex[:8]; old, new = f'o{t}@example.com', f'n{t}@example.com'
uid = call('POST', '/admin/users', {'email': old, 'password': 'Pw-x1234567!', 'email_confirm': True, 'user_metadata': {'locale': 'pl'}}, key=S)['id']
tok = call('POST', '/token?grant_type=password', {'email': old, 'password': 'Pw-x1234567!'})['access_token']
call('PUT', '/user', {'email': new}, bearer=tok)
r1 = click(body(f'n{t}')); r2 = click(body(f'o{t}'))
print('new-address link ->', r1); print('current-address link ->', r2)
print('email now', call('GET', f'/admin/users/{uid}', key=S)['email'] == new and 'CHANGED' or 'unchanged')
