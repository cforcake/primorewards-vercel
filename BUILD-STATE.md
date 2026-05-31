# Primo Rewards — Build State (Handoff for New Chat)
_Last updated: end of Dynamic QR Stamping + Analytics + Billing fixes session_

---

## Infrastructure
| Item | Value |
|------|-------|
| Supabase project ID | `plewiwrexjszcqqjwiks` |
| Supabase URL | `https://plewiwrexjszcqqjwiks.supabase.co` |
| Vercel team ID | `team_LcpmR4NshhlAB0EX8MneomP1` |
| Vercel project ID | `prj_7kTdtfKu9rvooMcxqphVoISfJku6` |
| GitHub repo | `cforcake/primorewards-vercel` |
| Domain | `primorewards.in` |
| Razorpay Key ID | `rzp_live_SvFdTi0JN5EMlI` |

---

## Supabase Secrets (all set)
```
DATABASE_SERVICE_ROLE_KEY
ADMIN_KEY
ADMIN_JWT_SECRET
MERCHANT_JWT_SECRET
RAZORPAY_WEBHOOK_SECRET
RAZORPAY_KEY_ID          = rzp_live_SvFdTi0JN5EMlI
RAZORPAY_KEY_SECRET
RAZORPAY_PLAN_STARTER
RAZORPAY_PLAN_PRO
RAZORPAY_PLAN_PREMIUM
RESEND_API_KEY
```

---

## Deployed Edge Functions (all ACTIVE)
| EF slug | Version | Auth method | Notes |
|---------|---------|-------------|-------|
| `enroll-subscribe` | v4 | Public, rate-limited 3/hr/IP | Sets status:'active' immediately on enrollment |
| `validate-coupon` | v7 | Public, rate-limited 5/min/IP | |
| `customer-lookup` | v21 | Public | |
| `customer-card` | v19 | Public | |
| `merchant-auth` | v23 | Slug + bcrypt → JWT | Blocks expired trials for pending_mandate AND cancelled sub |
| `merchant-api` | v26 | Merchant JWT (Bearer) | |
| `admin-auth` | v18 | Admin JWT | |
| `admin-data` | v19 | Admin JWT | |
| `admin-action` | v13 | Admin JWT | |
| `admin-coupons` | v7 | Admin JWT | |
| `admin-customers` | v15 | Admin JWT | |
| `create-subscription` | v9 | Admin JWT | |
| `send-email` | v10 | x-internal-key = SERVICE_KEY | |
| `razorpay-webhook` | v27 | HMAC-SHA256 signature | handleCancelled now checks trial_ends_at |
| `get-stamp-token` | v2 | Merchant JWT | Pro/Premium only. Returns {token, next_token, seconds_remaining} |
| `validate-stamp-qr` | v2 | Public, rate-limited 10/min/IP | Pro/Premium only. Validates TOTP, inserts stamp |
| `get-qr-feed` | v1 | Merchant JWT | Returns recent QR scans + customer info for live notifications |
| `get-analytics` | v1 | Merchant JWT | Pro/Premium only. Returns KPIs, chart, pipeline, attention, top customers |

### Common EF patterns
```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { create, verify } from 'https://deno.land/x/djwt@v2.9.1/mod.ts';

async function importKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', // or GET, OPTIONS
};
```

---

## Database Schema

### `shops` table
```sql
id                      UUID PK DEFAULT gen_random_uuid()
shop_name               TEXT NOT NULL
slug                    TEXT NOT NULL UNIQUE
city                    TEXT
owner_name              TEXT
owner_email             TEXT
owner_phone             TEXT
plan                    TEXT DEFAULT 'starter' CHECK (plan IN ('starter','pro','premium'))
status                  TEXT CHECK (status IN ('pending_payment','trial_pending','active','suspended'))
reward_rule             JSONB DEFAULT '{"buy":11,"get":1}'
product_name            TEXT DEFAULT 'item'
product_emoji           TEXT DEFAULT '🎁'
payment_id              TEXT
activated_at            TIMESTAMPTZ
created_at              TIMESTAMPTZ DEFAULT now()
coupon_code             TEXT REFERENCES coupons(code)
trial_ends_at           TIMESTAMPTZ
discount_ends_at        TIMESTAMPTZ
razorpay_subscription_id TEXT
subscription_status     TEXT DEFAULT 'none'
  -- values: none | pending_mandate | active | halted | cancelled
subscription_start_at   TIMESTAMPTZ
next_charge_at          TIMESTAMPTZ
subscription_plan       TEXT
mandate_url             TEXT
```

### `shop_secrets` table (migration 19 — QR stamping)
```sql
shop_id    UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE
secret     TEXT NOT NULL  -- 64-char hex (32 random bytes), HMAC key for QR tokens
created_at TIMESTAMPTZ DEFAULT now()
-- RLS: enabled, deny all for anon/authenticated (service_role only)
```

### `stamp_scans` table (migration 20 — QR fraud guard)
```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
shop_id       UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE
customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE
token_window  BIGINT NOT NULL   -- floor(unix_epoch_ms / 30000)
scanned_at    TIMESTAMPTZ DEFAULT now()
UNIQUE (shop_id, customer_id, token_window)  -- the fraud guard
-- Indexes: (shop_id, customer_id, token_window), (scanned_at), (shop_id)
-- Old rows (>48h) can be safely purged — they're only needed for active windows
```

### Other tables (unchanged)
`shop_enrollments`, `shop_credentials`, `customers`, `stamps`, `redemptions`,
`coupons`, `subscription_events`, `payments` — see previous schema.

---

## Frontend Files
| File | Purpose | Status |
|------|---------|--------|
| `index.html` | Landing page + enrollment form | ✅ Complete |
| `merchant.html` | Merchant dashboard | ✅ Complete — see notes below |
| `primo-shop-engine-v5.html` | Customer loyalty card + QR scanner | ✅ Complete |
| `primo-admin-v2.html` | Admin panel | ✅ Complete |
| `primo-rewards-v6.html` | Marketing page | ✅ Complete |

### merchant.html — current state
- **6 tabs:** Customers, WhatsApp, Analytics, Settings, QR & CSV, Stamp QR
- **Analytics tab** opens as full-screen overlay (position:fixed) — same pattern as Stamp QR
- **Stamp QR tab** opens as full-screen overlay (position:fixed, z-index:400)
  - Has countdown ring (SVG, TOTP-style) + live QR display
  - Polls `get-stamp-token` every second, prefetches at 2s remaining
  - Live notifications via `get-qr-feed` polling every 3s
  - Badge counter on tab button when merchant is on other tabs
- **Plan gates (Starter plan):**
  - Stamp QR tab → FOMO full-screen overlay (immediate, no API call)
  - WhatsApp tab → FOMO gate overlay
  - Analytics tab → FOMO gate overlay
  - Max 200 customers enforced client-side in confirmAdd()
  - Reward rule locked to Buy 10 → Get 1 Free (UI hidden, saveSets enforces it)
- **Billing cancelled banner:** updateTrialBanner() handles all states including
  'cancelled' (amber: "⚠ Billing cancelled — Xd left in trial")
- **QRCode.js** is inlined (no CDN dependency)
- CSP allows: `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`

### primo-shop-engine-v5.html — current state
- "Scan QR & Earn a Stamp" button on the loyalty card tab
- Full-screen BarcodeDetector scanner overlay with corner frame + scan line animation
- File input fallback for denied camera permission
- Permissions-Policy: `camera=(self)`
- Validates scanned slug matches customer's shop
- Shows stamp count + reward_ready on success

---

## Enrollment Flow (current — corrected)
```
1. Merchant fills form on primorewards.in
2. enroll-subscribe v4:
   - Creates shops record (status: 'active', subscription_status: 'pending_mandate')
   - Creates shop_secrets record (64-char hex HMAC secret)
   - Creates shop_enrollments record (status: 'trial_pending' — audit snapshot)
   - Creates shop_credentials (bcrypt temp password PR-XXXXXXXX)
   - Creates Razorpay subscription (start_at = 30 days out)
   - Sends trial_activation email (temp password + login URL + mandate URL)
3. Merchant logs in immediately (status:'active' from day 1)
   → Sees violet banner: "⚡ Xd left — billing mandate required"
   → Settings > Billing shows "Set up billing now" + mandate URL
4. Merchant completes mandate → subscription.authenticated webhook:
   → subscription_status: 'active', activated_at: now()
   → Banner disappears, billing_active email sent
5. Trial ends (30 days) → Razorpay auto-charges monthly
6. subscription.charged → payment_receipt email
7. subscription.halted → payment_failed email + urgent red banner
8. subscription.cancelled → handleCancelled checks trial_ends_at:
   - Still in trial: status='trial_pending', amber banner shown
   - Trial expired: status='suspended', login blocked
```

## Subscription State Machine
```
shops.status:        active (from day 1) → suspended (if cancelled after trial)
                     trial_pending (only if mandate cancelled during trial)
subscription_status: pending_mandate → active → halted | cancelled

merchant-auth v23 blocks login when:
  - status = 'suspended'
  - status not in ['active', 'trial_pending']
  - billing not set up (pending_mandate OR cancelled) AND trial_ends_at < now()
```

## Admin Panel Activate Button — meaning now
```
"✓ Activate" appears for: trial_pending status (mandate was cancelled during trial)
  → This means billing was disrupted, NOT a new enrollment needing action
"⏸ Suspend" appears for: active status (normal state for all enrolled shops)
"↺ Reinstate" appears for: suspended status
New enrollments show "⏸ Suspend" from day 1 — no admin action needed.
```

---

## Plan Limits — Starter vs Pro/Premium
| Feature | Starter | Pro | Premium |
|---------|---------|-----|---------|
| Customers | Max 200 | Unlimited | Unlimited |
| Reward rule | Buy 10 → Get 1 Free (locked) | Customisable | Customisable |
| WhatsApp alerts | ❌ (FOMO gate) | ✅ | ✅ |
| QR Stamping | ❌ (FOMO gate) | ✅ | ✅ |
| Analytics | ❌ (FOMO gate) | ✅ | ✅ |
| QR Stamp notifications | ❌ | ✅ | ✅ |

---

## Dynamic QR Stamping — HOW IT WORKS
```
Token = first 10 hex chars of HMAC-SHA256(shop_secret, floor(Date.now()/30000))
QR encodes: PRIMO:[slug]:[token]  e.g. PRIMO:test-cafe:a7f3k9b2c1
Rotates every 30 seconds → 2,880 unique QR codes per shop per day
±1 window tolerance (90s grace) for clock skew
UNIQUE(shop_id, customer_id, token_window) = DB-enforced fraud guard
Multiple customers CAN scan same QR — each gets own stamp (customer_id differs)
```

---

## ⚡ NEXT FEATURE TO BUILD: Trial Expiry Automation

### The gap
When a merchant cancels mandate during trial, they get `status:'trial_pending'`.
When trial_ends_at passes, merchant-auth blocks login — but:
1. No automated DB change to `status:'suspended'` (no cron job)
2. No trial-expiry email sent to merchant
3. No self-service reactivation (merchant locked out, can't access Settings to re-setup billing)
4. Admin must manually click "Activate" + merchant must re-setup billing

### What needs to be built

**Step 1 — Supabase scheduled cron job (pg_cron)**
Runs daily, suspends shops whose trial expired without billing:
```sql
UPDATE shops SET status = 'suspended'
WHERE status IN ('trial_pending', 'active')
  AND subscription_status IN ('pending_mandate', 'cancelled')
  AND trial_ends_at < now() - INTERVAL '1 day';
  -- 1 day grace period before hard suspend
```
Enable pg_cron in Supabase → Database → Extensions.

**Step 2 — Trial expiry email (send-email EF)**
New template: `trial_expired`
- Sent by the cron job (or a new `trial-expiry-notifier` EF) when suspending
- Contains: shop name, plan, link to reactivation page
- Also: reminder email 3 days before expiry (template: `trial_expiry_warning`)

**Step 3 — Self-service reactivation page**
New page or section on primorewards.in accessible WITHOUT login:
- URL: `primorewards.in/reactivate` OR `/merchant?reactivate=true`
- Merchant enters slug + temp/current password
- Page creates new Razorpay subscription (calls `create-subscription` or new EF)
- Opens Razorpay checkout → mandate → webhook → `status:'active'`
- No admin intervention needed

**Step 4 — New EF: `reactivate-billing`**
```
POST /reactivate-billing
Body: { slug, password, plan }
- Verifies credentials (bcrypt)
- Checks status is 'suspended' (or trial_pending with expired trial)
- Creates new Razorpay subscription
- Returns { subscription_id, mandate_url }
- Razorpay checkout opens → mandate → authenticated webhook → active
```

### Build order for next chat
1. Enable pg_cron, create daily suspension job
2. `trial-expiry-notifier` EF (or scheduled function) — emails at -3d and on expiry
3. `reactivate-billing` EF
4. Reactivation UI (lightweight page or modal on merchant login screen)
5. Test full cycle: cancel mandate → wait trial → suspend → reactivate

---

## Known Live Shops (test data)
| Shop | Slug | Plan | Status | Sub Status |
|------|------|------|--------|------------|
| Test Cafe | test-cafe | starter | active | pending_mandate |
| E2E TEST SHOP | e2e-test-shop | starter | active | pending_mandate |
| Niraj cafe | niraj-cafe | pro | active | pending_mandate |
| C for cake | c-for-cake | pro | active | pending_mandate |
| C for cake (2) | c-for-cake-2 | pro | active | pending_mandate |

All shops are in 30-day trial. No shop has completed mandate yet.
All have shop_secrets entries (QR stamping ready for Pro plans).
