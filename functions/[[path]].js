// Cloudflare Pages Functions entry. /api/* goes to the game API; everything else is static files.
import { handle } from '../src/api.js';
import { makeCtx } from '../src/ctx.js';
import { d1Port } from '../src/d1.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return context.next();
  if (!env.DB || !env.SEAL_KEY || !env.MASTER_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_configured', message: 'This deployment is not configured.' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  let ctx;
  try {
    ctx = makeCtx({
      db: d1Port(env.DB),
      env: {
        SEAL_KEY: env.SEAL_KEY, SEAL_KEY_ID: env.SEAL_KEY_ID, SEAL_KEYS_OLD: env.SEAL_KEYS_OLD, MASTER_SECRET: env.MASTER_SECRET, MASTER_SECRET_OLD: env.MASTER_SECRET_OLD,
        PLATFORM_TOKEN: env.PLATFORM_TOKEN, ALLOW_DEMO_PROVIDER: env.ALLOW_DEMO_PROVIDER, MNP_BASE_URL: env.MNP_BASE_URL, MNP_KEY_ID: env.MNP_KEY_ID, MNP_SECRET: env.MNP_SECRET, MNP_COMPANY_ID: env.MNP_COMPANY_ID, MNP_KEYS: env.MNP_KEYS,
        AI_KILL: env.AI_KILL, HUB_STATUS_URL: env.HUB_STATUS_URL, HUB_PRODUCT_CODE: env.HUB_PRODUCT_CODE, TERMS_URL: env.TERMS_URL, LAZY_TICK: env.LAZY_TICK,
      },
    });
  } catch {
    // a secret is too short or missing: fail closed, say nothing about which one
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_configured', message: 'This deployment is not configured.' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  return handle(ctx, request, {});
}
