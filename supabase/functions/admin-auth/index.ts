// ══════════════════════════════════════════════════════════════════════════════
// admin-auth — Phase 4 Login
// POST { key: string }
//
// Flow:
//   1. Constant-time compare: key === Deno.env.get('ADMIN_KEY')
//   2. Fixed delay on every response (prevents timing attacks)
//   3. On match → sign JWT { role: 'admin' } with 24h expiry
//   4. Return { token }
//   5. On fail → 401 (always after the same delay)
//
// Env vars required:
//   ADMIN_KEY         — the secret key that grants admin access
//   ADMIN_JWT_SECRET  — signs/verifies admin JWTs
// ══════════════════════════════════════════════════════════════════════════════

import { create } from 'https://deno.land/x/djwt@v2.9.1/mod.ts';
import { corsHeaders, json, importKey, timingSafeEqual } from '../_shared/cors.ts';

const ADMIN_KEY    = Deno.env.get('ADMIN_KEY')!;
const ADMIN_SECRET = Deno.env.get('ADMIN_JWT_SECRET')!;

// Fixed response delay — every response takes the same time regardless of
// whether the key is right or wrong, preventing timing-based key enumeration.
const FIXED_DELAY_MS = 400;

Deno.serve(async (req: Request) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Always wait the fixed delay before responding
  const delayPromise = new Promise(r => setTimeout(r, FIXED_DELAY_MS));

  try {
    const body = await req.json().catch(() => null);

    if (!body?.key) {
      await delayPromise;
      return json({ error: 'key is required' }, 400);
    }

    const { key } = body as { key: string };

    // Constant-time comparison — prevents timing attacks
    const valid = timingSafeEqual(key, ADMIN_KEY);

    await delayPromise; // always wait the same amount

    if (!valid) {
      return json({ error: 'Invalid admin key' }, 401);
    }

    // Sign JWT — 24 hour expiry
    const cryptoKey = await importKey(ADMIN_SECRET);
    const now = Math.floor(Date.now() / 1000);

    const token = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        role: 'admin',
        iat:  now,
        exp:  now + (60 * 60 * 24), // 24 hours
      },
      cryptoKey,
    );

    return json({ token });

  } catch (err) {
    await delayPromise;
    console.error('[admin-auth] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
