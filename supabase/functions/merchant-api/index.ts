// ══════════════════════════════════════════════════════════════════════════════
// merchant-api — Phase 3 All Operations (7 actions in one function)
// All requests: POST { action: string, ...payload }
// All requests require: Authorization: Bearer <merchantJWT>
//
// Actions:
//   load_dashboard  → return shop + all customers + stamps + redemptions
//   stamp           → { customer_id } → insert stamp, compute cycle server-side
//   redeem          → { customer_id } → verify eligibility, insert redemption
//   add_customer    → { first_name, phone_last4, full_phone?, birthday? }
//   edit_customer   → { customer_id, full_phone?, birthday? }
//   save_settings   → { product_name, product_emoji, reward_rule }
//   change_password → { new_password }
//
// Security rules enforced here (never trust the client):
//   - JWT verified on every request; shop_id extracted from token
//   - All queries scoped to jwt.shop_id — no cross-shop reads/writes
//   - cycle_number computed server-side — client-supplied value ignored
//   - customer ownership verified before stamp/redeem/edit
//
// Env vars required:
//   DATABASE_SERVICE_ROLE_KEY  — Supabase service role key
//   MERCHANT_JWT_SECRET        — verifies merchant JWTs
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as bcrypt from 'https://deno.land/x/bcrypt@v0.4.1/mod.ts';
import { verify } from 'https://deno.land/x/djwt@v2.9.1/mod.ts';
import { corsHeaders, json, importKey } from '../_shared/cors.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY     = Deno.env.get('DATABASE_SERVICE_ROLE_KEY')!;
const MERCHANT_SECRET = Deno.env.get('MERCHANT_JWT_SECRET')!;

// ── JWT verification ─────────────────────────────────────────────────────────
async function verifyToken(req: Request): Promise<{ shop_id: string; slug: string } | null> {
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    const key = await importKey(MERCHANT_SECRET);
    const payload = await verify(token, key);
    if (!payload.shop_id || !payload.slug) return null;
    return payload as { shop_id: string; slug: string };
  } catch {
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // ── Auth gate — every action requires a valid merchant JWT ───────────────
  const jwtPayload = await verifyToken(req);
  if (!jwtPayload) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const { shop_id } = jwtPayload;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json().catch(() => null);
    if (!body?.action) {
      return json({ error: 'action is required' }, 400);
    }

    const { action } = body as { action: string };

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: load_dashboard
    // Returns shop row + all customers + all stamps + all redemptions
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'load_dashboard') {
      const [shopRes, custRes, stampRes, redRes] = await Promise.all([
        sb.from('shops').select('*').eq('id', shop_id).single(),
        sb.from('customers').select('*').eq('shop_id', shop_id).order('enrolled_at', { ascending: false }),
        sb.from('stamps').select('*').eq('shop_id', shop_id),
        sb.from('redemptions').select('*').eq('shop_id', shop_id),
      ]);

      if (shopRes.error) throw shopRes.error;

      // Strip sensitive fields from shop object
      const { ...safeShop } = shopRes.data;
      delete (safeShop as Record<string,unknown>).admin_password;

      return json({
        shop:        safeShop,
        customers:   custRes.data  ?? [],
        stamps:      stampRes.data ?? [],
        redemptions: redRes.data   ?? [],
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: stamp
    // Adds one stamp to a customer. cycle_number computed server-side.
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'stamp') {
      const { customer_id } = body as { customer_id: string };
      if (!customer_id) return json({ error: 'customer_id is required' }, 400);

      // Verify customer belongs to this shop (prevent cross-shop stamping)
      const { data: cust, error: custErr } = await sb
        .from('customers').select('id, shop_id').eq('id', customer_id).single();
      if (custErr || !cust) return json({ error: 'Customer not found' }, 404);
      if (cust.shop_id !== shop_id) return json({ error: 'Forbidden' }, 403);

      // Fetch shop reward rule to know how many stamps = 1 cycle
      const { data: shop } = await sb
        .from('shops').select('reward_rule').eq('id', shop_id).single();
      const buyCount: number = shop?.reward_rule?.buy ?? 10;

      // Count total stamps so far (server-side — never trust client)
      const { count: totalStamps } = await sb
        .from('stamps')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customer_id)
        .eq('shop_id', shop_id);

      const stamps = totalStamps ?? 0;
      const cycleNumber = Math.floor(stamps / buyCount) + 1;

      const { data: newStamp, error: stampErr } = await sb
        .from('stamps')
        .insert({ shop_id, customer_id, cycle_number: cycleNumber })
        .select()
        .single();

      if (stampErr) throw stampErr;

      // How many stamps in the current cycle after this insert
      const stampsInCycle = (stamps % buyCount) + 1;

      return json({ success: true, stamp: newStamp, stamps_in_cycle: stampsInCycle, cycle_number: cycleNumber });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: redeem
    // Verifies the customer has enough stamps in current cycle, then redeems.
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'redeem') {
      const { customer_id } = body as { customer_id: string };
      if (!customer_id) return json({ error: 'customer_id is required' }, 400);

      // Verify customer ownership
      const { data: cust, error: custErr } = await sb
        .from('customers').select('id, shop_id').eq('id', customer_id).single();
      if (custErr || !cust) return json({ error: 'Customer not found' }, 404);
      if (cust.shop_id !== shop_id) return json({ error: 'Forbidden' }, 403);

      // Get reward rule
      const { data: shop } = await sb
        .from('shops').select('reward_rule').eq('id', shop_id).single();
      const buyCount: number = shop?.reward_rule?.buy ?? 10;

      // Count total stamps and redemptions to determine current cycle state
      const [{ count: totalStamps }, { count: totalReds }] = await Promise.all([
        sb.from('stamps').select('id', { count: 'exact', head: true })
          .eq('customer_id', customer_id).eq('shop_id', shop_id),
        sb.from('redemptions').select('id', { count: 'exact', head: true })
          .eq('customer_id', customer_id).eq('shop_id', shop_id),
      ]);

      const stamps = totalStamps ?? 0;
      const reds   = totalReds   ?? 0;

      // Current cycle number (1-based)
      const cycleNumber = Math.floor(stamps / buyCount) + 1;
      // Stamps in the current cycle
      const stampsInCycle = stamps % buyCount;
      // Has this cycle already been redeemed?
      const { count: cycleReds } = await sb
        .from('redemptions').select('id', { count: 'exact', head: true })
        .eq('customer_id', customer_id).eq('shop_id', shop_id)
        .eq('cycle_number', cycleNumber - 1); // completed cycles are cycleNumber-1

      // Customer needs buyCount stamps before redeeming
      if (stamps < buyCount * (reds + 1)) {
        return json({ error: `Customer needs ${buyCount - (stamps - reds * buyCount)} more stamps to redeem` }, 400);
      }

      // Determine which cycle is being redeemed (the last completed cycle)
      const redeemCycle = reds + 1;

      const { data: redemption, error: redErr } = await sb
        .from('redemptions')
        .insert({ shop_id, customer_id, cycle_number: redeemCycle })
        .select()
        .single();

      if (redErr) {
        if (redErr.code === '23505') {
          return json({ error: 'Reward already redeemed for this cycle' }, 409);
        }
        throw redErr;
      }

      return json({ success: true, redemption });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: add_customer
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'add_customer') {
      const { first_name, phone_last4, full_phone, birthday } = body as {
        first_name: string; phone_last4: string; full_phone?: string; birthday?: string;
      };

      if (!first_name || !phone_last4) {
        return json({ error: 'first_name and phone_last4 are required' }, 400);
      }
      if (!/^\d{4}$/.test(phone_last4)) {
        return json({ error: 'phone_last4 must be exactly 4 digits' }, 400);
      }

      const insertData: Record<string, unknown> = {
        shop_id,
        first_name: first_name.trim(),
        phone_last4,
      };
      if (full_phone)  insertData.full_phone  = full_phone;
      if (birthday)    insertData.birthday    = birthday;

      const { data: customer, error: insErr } = await sb
        .from('customers').insert(insertData).select().single();

      if (insErr) {
        if (insErr.code === '23505') {
          return json({ error: 'A customer with this name and phone already exists' }, 409);
        }
        throw insErr;
      }

      return json({ success: true, customer });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: edit_customer
    // Only full_phone and birthday can be updated — never name or phone_last4
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'edit_customer') {
      const { customer_id, full_phone, birthday } = body as {
        customer_id: string; full_phone?: string; birthday?: string;
      };
      if (!customer_id) return json({ error: 'customer_id is required' }, 400);

      // Verify ownership
      const { data: cust, error: custErr } = await sb
        .from('customers').select('id, shop_id').eq('id', customer_id).single();
      if (custErr || !cust) return json({ error: 'Customer not found' }, 404);
      if (cust.shop_id !== shop_id) return json({ error: 'Forbidden' }, 403);

      const updates: Record<string, unknown> = {};
      if (full_phone !== undefined) updates.full_phone = full_phone || null;
      if (birthday   !== undefined) updates.birthday   = birthday   || null;

      if (Object.keys(updates).length === 0) {
        return json({ error: 'No updatable fields provided' }, 400);
      }

      const { error: updErr } = await sb
        .from('customers').update(updates).eq('id', customer_id).eq('shop_id', shop_id);

      if (updErr) throw updErr;

      return json({ success: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: save_settings
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'save_settings') {
      const { product_name, product_emoji, reward_rule } = body as {
        product_name?: string; product_emoji?: string;
        reward_rule?: { buy: number; get: number };
      };

      const updates: Record<string, unknown> = {};

      if (product_name  !== undefined) updates.product_name  = product_name.trim();
      if (product_emoji !== undefined) updates.product_emoji = product_emoji;
      if (reward_rule   !== undefined) {
        const { buy, get } = reward_rule;
        if (!Number.isInteger(buy) || buy < 1 || buy > 50) {
          return json({ error: 'reward_rule.buy must be an integer between 1 and 50' }, 400);
        }
        if (!Number.isInteger(get) || get < 1 || get > 10) {
          return json({ error: 'reward_rule.get must be an integer between 1 and 10' }, 400);
        }
        updates.reward_rule = { buy, get };
      }

      if (Object.keys(updates).length === 0) {
        return json({ error: 'No settings provided to update' }, 400);
      }

      const { data: updatedShop, error: updErr } = await sb
        .from('shops').update(updates).eq('id', shop_id).select().single();

      if (updErr) throw updErr;

      return json({ success: true, shop: updatedShop });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACTION: change_password
    // ════════════════════════════════════════════════════════════════════════
    if (action === 'change_password') {
      const { new_password } = body as { new_password: string };
      if (!new_password || new_password.length < 6) {
        return json({ error: 'Password must be at least 6 characters' }, 400);
      }

      const hash = await bcrypt.hash(new_password, 10);

      const { error: upsertErr } = await sb
        .from('shop_credentials')
        .upsert({ shop_id, password_hash: hash, updated_at: new Date().toISOString() });

      if (upsertErr) throw upsertErr;

      return json({ success: true });
    }

    // Unknown action
    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error('[merchant-api]', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
