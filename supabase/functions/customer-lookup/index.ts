// ══════════════════════════════════════════════════════════════════════════════
// customer-lookup — Phase 2 Login
// POST { slug: string, first_name: string, phone_last4: string }
//
// Flow:
//   1. Fetch shop by slug from public_shop_card view (active shops only)
//   2. Look up customer WHERE shop_id + first_name + phone_last4
//   3. If not found → INSERT new customer (self-enrollment)
//   4. Return { customer_id, shop } — NEVER return full_phone or other PII
//
// No auth required — this is the public customer-facing login endpoint.
// All sensitive data reads are scoped by the unique (shop, name, last4) triplet.
//
// Env vars required:
//   DATABASE_SERVICE_ROLE_KEY  — Supabase service role key
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('DATABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);

    if (!body?.slug || !body?.first_name || !body?.phone_last4) {
      return json({ error: 'slug, first_name, and phone_last4 are required' }, 400);
    }

    const { slug, first_name, phone_last4 } = body as {
      slug: string; first_name: string; phone_last4: string;
    };

    // Validate phone_last4
    if (!/^\d{4}$/.test(phone_last4)) {
      return json({ error: 'phone_last4 must be exactly 4 digits' }, 400);
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Step 1: Fetch active shop from public_shop_card view ────────────────
    // View already filters to status = 'active' and exposes no PII
    const { data: shop, error: shopErr } = await sb
      .from('public_shop_card')
      .select('id, shop_name, slug, city, status, reward_rule, product_name, product_emoji')
      .eq('slug', slug)
      .single();

    if (shopErr || !shop) {
      return json({ error: 'Shop not found or not active' }, 404);
    }

    // ── Step 2: Find or create customer ────────────────────────────────────
    const nameNorm = first_name.trim();

    let { data: customer, error: custErr } = await sb
      .from('customers')
      .select('id, first_name, phone_last4, enrolled_at')
      .eq('shop_id', shop.id)
      .eq('first_name', nameNorm)
      .eq('phone_last4', phone_last4)
      .single();

    // ── Step 3: Auto-enroll if not found ───────────────────────────────────
    if (custErr && custErr.code === 'PGRST116') {
      // PGRST116 = "no rows found" — create the customer
      const { data: newCust, error: insErr } = await sb
        .from('customers')
        .insert({ shop_id: shop.id, first_name: nameNorm, phone_last4 })
        .select('id, first_name, phone_last4, enrolled_at')
        .single();

      if (insErr) {
        if (insErr.code === '23505') {
          // Race condition: another request created it — fetch it
          const { data: existing } = await sb
            .from('customers')
            .select('id, first_name, phone_last4, enrolled_at')
            .eq('shop_id', shop.id)
            .eq('first_name', nameNorm)
            .eq('phone_last4', phone_last4)
            .single();
          customer = existing;
        } else {
          throw insErr;
        }
      } else {
        customer = newCust;
      }
    } else if (custErr) {
      throw custErr;
    }

    if (!customer) {
      return json({ error: 'Could not find or create customer' }, 500);
    }

    // Return only safe fields — never full_phone, never full shop PII
    return json({
      customer_id:  customer.id,
      first_name:   customer.first_name,
      enrolled_at:  customer.enrolled_at,
      shop,           // safe shop object from public_shop_card view
    });

  } catch (err) {
    console.error('[customer-lookup] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
