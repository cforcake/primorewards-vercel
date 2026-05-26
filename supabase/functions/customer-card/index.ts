// ══════════════════════════════════════════════════════════════════════════════
// customer-card — Phase 2 Card Data
// POST { customer_id: string, shop_id: string }
//
// Flow:
//   1. Verify customer.shop_id === request.shop_id (prevent cross-shop reads)
//   2. Fetch all stamps for customer+shop
//   3. Fetch all redemptions for customer+shop
//   4. Return { stamps, redemptions }
//
// No auth token required — customer_id is a UUID (non-guessable).
// The cross-shop ownership check is the security boundary.
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

    if (!body?.customer_id || !body?.shop_id) {
      return json({ error: 'customer_id and shop_id are required' }, 400);
    }

    const { customer_id, shop_id } = body as { customer_id: string; shop_id: string };

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Step 1: Verify customer belongs to the claimed shop ─────────────────
    // This prevents a customer from requesting another shop's card data
    // by supplying a different shop_id.
    const { data: customer, error: custErr } = await sb
      .from('customers')
      .select('id, shop_id, first_name, phone_last4, enrolled_at')
      .eq('id', customer_id)
      .single();

    if (custErr || !customer) {
      return json({ error: 'Customer not found' }, 404);
    }

    if (customer.shop_id !== shop_id) {
      // Return 404 not 403 — don't confirm the customer exists in another shop
      return json({ error: 'Customer not found' }, 404);
    }

    // ── Step 2: Fetch stamps + redemptions in parallel ──────────────────────
    const [stampsRes, redsRes] = await Promise.all([
      sb.from('stamps')
        .select('id, cycle_number, stamped_at')
        .eq('customer_id', customer_id)
        .eq('shop_id', shop_id)
        .order('stamped_at', { ascending: true }),

      sb.from('redemptions')
        .select('id, cycle_number, redeemed_at')
        .eq('customer_id', customer_id)
        .eq('shop_id', shop_id)
        .order('redeemed_at', { ascending: true }),
    ]);

    if (stampsRes.error) throw stampsRes.error;
    if (redsRes.error)   throw redsRes.error;

    return json({
      stamps:      stampsRes.data ?? [],
      redemptions: redsRes.data   ?? [],
    });

  } catch (err) {
    console.error('[customer-card] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
