// ══════════════════════════════════════════════════════════════════════════════
// razorpay-webhook — Payment Processing
// POST (called by Razorpay servers — NOT from the frontend)
//
// Flow:
//   1. Read raw body as text (must be raw — JSON.parse invalidates the HMAC)
//   2. HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET) === x-razorpay-signature
//   3. On mismatch → 400 immediately (do not process)
//   4. Parse event — only handle 'payment.captured'
//   5. Extract shop_id from payment.notes (set during Phase 1 checkout)
//   6. PATCH shops SET status='active', activated_at=NOW()
//   7. INSERT into payments
//   8. Return 200 (Razorpay retries on non-200)
//
// Env vars required:
//   DATABASE_SERVICE_ROLE_KEY  — Supabase service role key
//   RAZORPAY_WEBHOOK_SECRET    — from Razorpay dashboard → Webhooks
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY      = Deno.env.get('DATABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET   = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')!;

// ── HMAC-SHA256 verification ─────────────────────────────────────────────────
async function verifyRazorpaySignature(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const hexSig = Array.from(new Uint8Array(sigBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return hexSig === signature;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {

  // Razorpay sends POST — no OPTIONS preflight from their servers
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // ── Step 1: Read raw body BEFORE parsing ────────────────────────────────
  // Must be raw text — JSON.stringify(JSON.parse(x)) can reorder keys
  // and invalidate the HMAC signature.
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  // ── Step 2: Verify HMAC signature ───────────────────────────────────────
  const valid = await verifyRazorpaySignature(rawBody, signature, WEBHOOK_SECRET);

  if (!valid) {
    console.warn('[razorpay-webhook] Invalid signature — rejected');
    return new Response('Invalid signature', { status: 400 });
  }

  // ── Step 3: Parse the event ─────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const eventName = event.event as string;

  // ── Step 4: Only handle payment.captured ────────────────────────────────
  if (eventName !== 'payment.captured') {
    // Acknowledge other events without processing
    console.log(`[razorpay-webhook] Ignored event: ${eventName}`);
    return new Response('OK', { status: 200 });
  }

  try {
    // ── Step 5: Extract payment details ─────────────────────────────────
    const payload     = event.payload as Record<string, unknown>;
    const paymentObj  = (payload?.payment as Record<string, unknown>)?.entity as Record<string, unknown>;

    if (!paymentObj) {
      console.error('[razorpay-webhook] Missing payment entity in payload');
      return new Response('Bad payload', { status: 400 });
    }

    const razorpay_payment_id = paymentObj.id as string;
    const amount              = Number(paymentObj.amount) / 100; // Razorpay sends paise → convert to rupees
    const notes               = (paymentObj.notes ?? {}) as Record<string, string>;

    // Phase 1 must pass shop_id in Razorpay notes at checkout creation time
    const shop_id = notes.shop_id;
    const plan    = notes.plan ?? 'starter';

    if (!shop_id) {
      console.error('[razorpay-webhook] Missing shop_id in payment notes', notes);
      // Return 200 to prevent Razorpay from retrying — this is a data issue not a server issue
      return new Response('Missing shop_id in notes', { status: 200 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const now = new Date().toISOString();

    // ── Step 6: Activate shop ──────────────────────────────────────────────
    const { error: shopErr } = await sb
      .from('shops')
      .update({ status: 'active', activated_at: now, payment_id: razorpay_payment_id })
      .eq('id', shop_id)
      .eq('status', 'pending_payment'); // only activate if pending — idempotent

    if (shopErr) {
      console.error('[razorpay-webhook] Failed to activate shop:', shopErr);
      // Return 500 so Razorpay retries
      return new Response('Database error', { status: 500 });
    }

    // ── Step 7: Record payment ─────────────────────────────────────────────
    const { error: payErr } = await sb
      .from('payments')
      .insert({
        shop_id,
        razorpay_payment_id,
        amount,
        plan,
        status: 'captured',
        type: 'payment',
        captured_at: now,
      });

    if (payErr) {
      // Duplicate key = already processed (Razorpay retry) — log and acknowledge
      if (payErr.code === '23505') {
        console.log(`[razorpay-webhook] Duplicate payment ${razorpay_payment_id} — already processed`);
      } else {
        console.error('[razorpay-webhook] Failed to insert payment:', payErr);
        return new Response('Database error', { status: 500 });
      }
    }

    console.log(`[razorpay-webhook] ✅ Shop ${shop_id} activated. Payment: ₹${amount}`);

    // ── Step 8: Return 200 — Razorpay retries on non-200 ──────────────────
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('[razorpay-webhook] Unexpected error:', err);
    // Return 500 so Razorpay retries — the shop must be activated
    return new Response('Internal server error', { status: 500 });
  }
});
