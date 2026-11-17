// Opens a company through the platform route. Usage:
//   FLOOR_URL=https://your-host PLATFORM_TOKEN=... node scripts/new-company.js --name "Acme" --slug acme --admin-email boss@acme.example --admin-name "Boss" [--provider moneypenny]
// The token comes from the environment only and is never printed. The one-time invite code for the admin is printed once.
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };

export async function newCompany({ base, token, name, slug, adminEmail, adminName, provider }, fetchFn = fetch) {
  if (!/^https:\/\/[^\s/]+\/?$/.test(base ?? '') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base ?? '')) throw new Error('FLOOR_URL must be an https address (or localhost for a local run).');
  if (!token || token.length < 24) throw new Error('PLATFORM_TOKEN is not set (24 or more characters).');
  if (!name || !slug || !adminEmail) throw new Error('Needed: --name, --slug and --admin-email.');
  const r = await fetchFn(base.replace(/\/$/, '') + '/api/platform/company', {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ name, slug, admin_email: adminEmail, admin_name: adminName ?? '', provider: provider === 'moneypenny' ? 'moneypenny' : 'stub' }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new Error('The server said no (' + r.status + '): ' + (j?.error?.code ?? 'unknown'));
  return j;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  newCompany({ base: process.env.FLOOR_URL, token: process.env.PLATFORM_TOKEN, name: arg('name'), slug: arg('slug'), adminEmail: arg('admin-email'), adminName: arg('admin-name'), provider: arg('provider') })
    .then((j) => { console.log('Company opened: ' + j.company_id + '\nAdmin id: ' + j.admin_id + '\nInvite code (shown once): ' + j.invite_code); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
