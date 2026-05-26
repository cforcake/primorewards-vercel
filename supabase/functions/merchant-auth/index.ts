// ══════════════════════════════════════════════════════════════════════════════
// merchant-auth — Phase 3 Login
// POST { slug: string, password: string }
// Deploy via: Supabase Dashboard → Edge Functions → Deploy new function
// Function name: merchant-auth
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as bcrypt from 'https://deno.land/x/bcrypt@v0.4.1/mod.ts';
import { create } from 'https://deno.land/x/djwt@v2.9.1/mod.ts';

// ── Inlined from _shared/cors.ts ─────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function importKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY     = Deno.env.get('DATABASE_SERVICE_ROLE_KEY')!;
const MERCHANT_SECRET = Deno.env.get('MERCHANT_JWT_SECRET')!;

Deno.serve(async (req: Request) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);

    if (!body?.slug || !body?.password) {
      return json({ error: 'slug and password are required' }, 400);
    }

    const { slug, password } = body as { slug: string; password: string };

    if (!/^[a-z0-9-]+$/.test(slug)) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Step 1: Fetch shop by slug ─────────────────────────────────────────
    const { data: shop, error: shopErr } = await sb
      .from('shops')
      .select('id, shop_name, slug, city, plan, status, reward_rule, product_name, product_emoji')
      .eq('slug', slug)
      .single();

    if (shopErr || !shop) {
      await new Promise(r => setTimeout(r, 400));
      return json({ error: 'Invalid credentials' }, 401);
    }

    // ── Step 2: Check shop is active ───────────────────────────────────────
    if (shop.status !== 'active') {
      await new Promise(r => setTimeout(r, 400));
      return json({ error: 'Shop is not active. Contact support.' }, 403);
    }

    // ── Step 3: Fetch password hash (service role only — RLS blocks anon) ──
    const { data: creds, error: credsErr } = await sb
      .from('shop_credentials')
      .select('password_hash')
      .eq('shop_id', shop.id)
      .single();

    if (credsErr || !creds?.password_hash) {
      await new Promise(r => setTimeout(r, 400));
      return json({ error: 'Invalid credentials' }, 401);
    }

    // ── Step 4: bcrypt compare ─────────────────────────────────────────────
    const valid = await bcrypt.compare(password, creds.password_hash);
    if (!valid) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    // ── Step 5: Sign JWT — 4 hour expiry ──────────────────────────────────
    const key = await importKey(MERCHANT_SECRET);
    const now = Math.floor(Date.now() / 1000);

    const token = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        shop_id: shop.id,
        slug:    shop.slug,
        iat:     now,
        exp:     now + (60 * 60 * 4),
      },
      key,
    );

    return json({ token, shop });

  } catch (err) {
    console.error('[merchant-auth] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
