// ══════════════════════════════════════════════════════════════════════════════
// admin-data — Phase 4 Dashboard Data
// POST {} (requires Authorization: Bearer <adminJWT>)
//
// Returns:
//   {
//     shops:       ShopRow[],
//     customers:   Record<shop_id, count>,
//     stamps:      Record<shop_id, count>,
//     redemptions: Record<shop_id, count>,
//     payments:    PaymentRow[],
//     audit_log:   AuditLogRow[]   // newest first
//   }
//
// Env vars required:
//   DATABASE_SERVICE_ROLE_KEY  — Supabase service role key
//   ADMIN_JWT_SECRET           — verifies admin JWTs
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.9.1/mod.ts';
import { corsHeaders, json, importKey } from '../_shared/cors.ts';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY   = Deno.env.get('DATABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET  = Deno.env.get('ADMIN_JWT_SECRET')!;

// ── Admin JWT verification ───────────────────────────────────────────────────
async function verifyAdminToken(req: Request): Promise<boolean> {
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return false;
    const token = auth.slice(7);
    const key = await importKey(ADMIN_SECRET);
    const payload = await verify(token, key);
    return payload.role === 'admin';
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const isAdmin = await verifyAdminToken(req);
  if (!isAdmin) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch all data in parallel for speed
    const [shopsRes, customersRes, stampsRes, redemptionsRes, paymentsRes, auditRes] =
      await Promise.all([
        sb.from('shops')
          .select('*')
          .order('created_at', { ascending: false }),

        sb.from('customers')
          .select('shop_id, id'),

        sb.from('stamps')
          .select('shop_id, id'),

        sb.from('redemptions')
          .select('shop_id, id'),

        sb.from('payments')
          .select('*')
          .order('captured_at', { ascending: false }),

        sb.from('admin_audit_log')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

    if (shopsRes.error) throw shopsRes.error;

    // Aggregate customers/stamps/redemptions per shop_id
    const toCountMap = (rows: Array<{ shop_id: string }> | null): Record<string, number> => {
      const map: Record<string, number> = {};
      for (const row of rows ?? []) {
        map[row.shop_id] = (map[row.shop_id] ?? 0) + 1;
      }
      return map;
    };

    return json({
      shops:       shopsRes.data       ?? [],
      customers:   toCountMap(customersRes.data),
      stamps:      toCountMap(stampsRes.data),
      redemptions: toCountMap(redemptionsRes.data),
      payments:    paymentsRes.data    ?? [],
      audit_log:   auditRes.data       ?? [],
    });

  } catch (err) {
    console.error('[admin-data] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
