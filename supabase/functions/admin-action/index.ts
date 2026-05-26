// ══════════════════════════════════════════════════════════════════════════════
// admin-action — Phase 4 Shop Status Changes
// POST { action: 'activate'|'suspend'|'reinstate', shop_id: string }
// Requires: Authorization: Bearer <adminJWT>
//
// Legal status transitions:
//   pending_payment → active     (activate)
//   active          → suspended  (suspend)
//   suspended       → active     (reinstate)
//
// Every action writes an admin_audit_log row.
//
// Env vars required:
//   DATABASE_SERVICE_ROLE_KEY  — Supabase service role key
//   ADMIN_JWT_SECRET           — verifies admin JWTs
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.9.1/mod.ts';
import { corsHeaders, json, importKey } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('DATABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET = Deno.env.get('ADMIN_JWT_SECRET')!;

type AdminAction = 'activate' | 'suspend' | 'reinstate';

// Allowed transitions: [from_status] → [valid actions]
const TRANSITIONS: Record<string, { action: AdminAction; to: string }[]> = {
  'pending_payment': [{ action: 'activate',   to: 'active' }],
  'active':          [{ action: 'suspend',    to: 'suspended' }],
  'suspended':       [{ action: 'reinstate',  to: 'active' }],
};

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
    const body = await req.json().catch(() => null);

    if (!body?.action || !body?.shop_id) {
      return json({ error: 'action and shop_id are required' }, 400);
    }

    const { action, shop_id } = body as { action: AdminAction; shop_id: string };

    const validActions: AdminAction[] = ['activate', 'suspend', 'reinstate'];
    if (!validActions.includes(action)) {
      return json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, 400);
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch current shop
    const { data: shop, error: shopErr } = await sb
      .from('shops')
      .select('id, shop_name, status')
      .eq('id', shop_id)
      .single();

    if (shopErr || !shop) {
      return json({ error: 'Shop not found' }, 404);
    }

    // Validate the transition is legal
    const allowed = TRANSITIONS[shop.status] ?? [];
    const transition = allowed.find(t => t.action === action);

    if (!transition) {
      return json({
        error: `Cannot ${action} a shop with status '${shop.status}'`,
        current_status: shop.status,
      }, 409);
    }

    const newStatus = transition.to;
    const now = new Date().toISOString();

    // Extract IP for audit log
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? req.headers.get('cf-connecting-ip')
      ?? 'unknown';

    // Run status update + audit log insert in parallel
    const [updateRes, auditRes] = await Promise.all([
      sb.from('shops').update({
        status: newStatus,
        ...(action === 'activate' ? { activated_at: now } : {}),
      }).eq('id', shop_id),

      sb.from('admin_audit_log').insert({
        action_type:  action,
        target_id:    shop_id,
        shop_name:    shop.shop_name,
        performed_by: 'admin',
        old_status:   shop.status,
        new_status:   newStatus,
        ip_address:   ip,
      }),
    ]);

    if (updateRes.error) throw updateRes.error;
    if (auditRes.error)  throw auditRes.error;

    return json({ success: true, shop_id, new_status: newStatus });

  } catch (err) {
    console.error('[admin-action] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
