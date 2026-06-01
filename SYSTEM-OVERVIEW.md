# Primo Rewards — Honest System Overview
> Generated from live project data on 1 June 2026.
> No sugarcoating. Numbers from actual DB, not estimates.

---

## Current Live State (the real picture)

| Metric | Live Count |
|---|---|
| Total shops | 5 |
| Active shops | 4 |
| Suspended shops | 1 (c-for-cake-2, ghost duplicate) |
| Trial-pending shops | 0 |
| **Paying shops** | **0** |
| **Real money processed** | **₹0 — payments table is empty** |
| Customers registered | 7 |
| Stamps given | 37 |
| Redemptions | 3 |
| Coupons created | 0 |
| Subscription events logged | 10 |
| Admin audit log rows | 5 |

### The 4 "active" shops in truth

| Shop | Customers | Stamps | Subscription status | Billing mandates done |
|---|---|---|---|---|
| test-cafe (test) | 4 | 34 | pending_mandate | ❌ No |
| e2e-test-shop (test) | 1 | 0 | pending_mandate | ❌ No |
| c-for-cake (real) | 0 | 0 | pending_mandate | ❌ No |
| niraj-cafe (real) | 2 | 3 | pending_mandate | ❌ No |

**Reality check:** Every "active" shop is active by admin manual activation, not because they completed a Razorpay mandate. The `subscription.authenticated` webhook has never fired in production. No shop is actually paying yet.

---

## Infrastructure

### Stack
- **DB:** Supabase PostgreSQL (free tier, 500MB limit)
- **Backend:** 26 Supabase Edge Functions (Deno runtime)
- **Frontend:** Vercel static hosting (HTML/CSS/JS — no framework)
- **Payments:** Razorpay subscriptions
- **Email:** Resend (FROM: welcome@primorewards.in)
- **Automation:** pg_cron (2 daily jobs at 00:30 IST)
- **Alerting:** Email to support@primorewards.in via Resend

### Edge Functions (26 total, all ACTIVE)

**Enrollment & Auth (4)**
- `enroll-subscribe` v6 — Merchant signup with Razorpay subscription creation. Email dedup. IP rate-limited (3/hr). ✅ Production tested.
- `merchant-auth` v24 — JWT login with bcrypt. 4-hour token expiry. ✅ Production tested.
- `merchant-reset-password` v2 — Forgotten password via email. Sends temp password. ✅ Built, minimally tested.
- `admin-auth` v20 — Admin key verification. Returns JWT. ✅ Tested.

**Merchant Operations (3)**
- `merchant-api` v28 — Dashboard data load, stamp givin, redemptions. ✅ Most-used EF, production tested.
- `upgrade-plan` v2 — Next-cycle plan upgrade. Creates new Razorpay sub. ⚠️ Built, never tested end-to-end with real money.
- `cancel-upgrade-plan` v2 — Cancels pending plan upgrade. ⚠️ Built, untested in production.

**Billing & Payments (7)**
- `razorpay-webhook` v31 — Handles authenticated/charged/halted/cancelled events. HMAC verified. ✅ Structurally correct. ⚠️ `subscription.charged` never fired with real money.
- `create-subscription` v11 — Admin-triggered sub creation. ✅ Used when admin manually activates shops.
- `reactivate-billing` v3 — Self-service reactivation for suspended/expired shops. IP rate-limited. ✅ Built, minimally tested.
- `sync-billing-status` v2 — Merchant-side "verify payment" button. ✅ Tested.
- `refresh-mandate` v2 — Fetches fresh mandate URL from Razorpay. ✅ Built.
- `reconcile-payments` v2 — Finds missed charges by comparing Razorpay invoices vs DB. ⚠️ Built, no real payments to reconcile yet.
- `upgrade-plan` / `cancel-upgrade-plan` — See above.

**Customer Experience (4)**
- `customer-lookup` v23 — Looks up customer by phone for stamping. ✅ Production tested.
- `customer-card` v21 — Full loyalty card data (stamps, progress). ✅ Production tested.
- `get-stamp-token` v3 — Generates QR stamp token. ✅ Production tested.
- `validate-stamp-qr` v3 — Validates QR scan from customer phone. ✅ Production tested.

**Admin (5)**
- `admin-data` v22 — Paginated shop list, stats, payments. Handles 1000+ shops. ✅ Tested today (fixed ghost column bug).
- `admin-action` v22 — Activate/suspend/reinstate + Sync Razorpay. ✅ Tested.
- `admin-customers` v17 — Customer management. ✅ Built.
- `admin-coupons` v9 — Coupon CRUD. ✅ Built, 0 coupons used.
- `get-analytics` v2 — Analytics data. ✅ Built.

**Infrastructure (3)**
- `send-email` v12 — All transactional emails via Resend. ✅ Production tested.
- `trial-expiry-notifier` v4 — Nightly T-3d warning + T+0 expiry emails. ✅ Runs via pg_cron daily.
- `validate-coupon` v9 — Coupon validation at enrollment. ✅ Built, 0 coupons used.

**Utility (3)**
- `get-qr-feed` v2 — QR stamping feed. ✅ Built.
- `ping-alert` v2 — Decommissioned test EF. Returns 410.
- `enroll-subscribe` — see above.

### Database Tables (15)

| Table | Rows | Purpose |
|---|---|---|
| shops | 5 | Core shop records |
| customers | 7 | Registered loyalty customers |
| stamps | 37 | Stamp history |
| redemptions | 3 | Redemption history |
| payments | **0** | Razorpay payment records (nothing yet) |
| subscription_events | 10 | Webhook + billing audit trail |
| admin_audit_log | 5 | Admin actions (activate/suspend) |
| shop_credentials | 5 | bcrypt password hashes |
| shop_enrollments | 1 | Enrollment funnel tracking |
| coupons | 0 | Discount codes |
| cron_nonces | 1 | pg_cron auth nonce |
| stamp_scans | 4 | QR scan records |
| merchant_reviews | 6 | Reviews (purpose unclear, not used in current UI) |
| rate_limits | 0 | Unused table (rate limiting is in-memory) |
| shop_secrets | 5 | Per-shop secrets storage |

### Automation
- **suspend-expired-trials** — Runs 00:30 IST daily via pg_cron. Suspends shops whose trial ended AND mandate was never completed. ✅ Running.
- **trial-expiry-notifier-cron** — Runs 00:35 IST daily via pg_cron. Sends T-3d warning and T+0 expired emails. ✅ Running.

---

## What Each Role Can Actually Do

### Rank 1 — Customer (most reliable)
Customers interact only via the loyalty card page (`primorewards.in/{slug}-reward`).

✅ Register phone number to get a loyalty card
✅ See current stamp count and progress toward reward
✅ Get stamps manually (merchant enters phone in dashboard)
✅ Get stamps via QR code scan (merchant shows QR, customer scans)
✅ Trigger redemption when stamp count is full
✅ Card updates in real-time after each stamp

❌ Cannot view stamp history (only current count shown)
❌ Cannot opt out / delete their data themselves
❌ Cannot receive push notifications or WhatsApp confirmations
❌ Card is per-shop (no cross-shop customer identity)

**Honest reliability: High.** This flow is the most tested. 37 stamps given across 7 customers.

---

### Rank 2 — Admin (reliable with caveats)
Admin panel at `primorewards.in/admin`.

✅ Login with admin key (server-validated JWT, 15-attempt lockout)
✅ View all shops with stats (customers, stamps, redemptions)
✅ Search shops by name, email, city (server-side, handles 1000+ shops)
✅ Filter by status (active/pending/suspended)
✅ Activate / Suspend / Reinstate shops
✅ View per-shop subscription status and Razorpay sub ID
✅ Sync shop status from Razorpay (if webhook was missed)
✅ Reconcile missing payments from Razorpay invoices
✅ Manage coupons (create, toggle, delete)
✅ View enrollment funnel with WhatsApp follow-up links
✅ View audit log of admin actions
✅ Export shops as CSV
✅ View MRR breakdown by plan
✅ View Razorpay payment log

⚠️ MRR is estimated from plan labels, not from actual payments (payments table = 0)
⚠️ Revenue tab shows "no payment records" — accurate, never been charged
❌ Cannot bulk-action multiple shops
❌ Cannot view per-customer data across shops in one view
❌ Cannot find duplicate customers (same phone, different shops)
❌ No search within audit log

**Honest reliability: High for shop management. Revenue data is fictional until first charge fires.**

---

### Rank 3 — Merchant (reliable but several edge cases)
Merchant dashboard at `primorewards.in/merchant`.

✅ Login with slug + password (bcrypt, JWT 4-hour session)
✅ Forgot password → email with temp password
✅ View dashboard (today's stamps, total customers, redemptions)
✅ Give stamps manually (enter customer phone → stamp)
✅ Show QR code for customer to scan
✅ Trigger redemption
✅ View analytics (stamps/redemptions trend)
✅ View billing status with plan name + trial end date
✅ Update payment method (halted subscription → mandate link)
✅ Verify payment status manually (missed webhook recovery)
✅ Upgrade plan self-service (Starter → Pro → Premium)
✅ Cancel pending plan upgrade
✅ Reactivate billing if suspended/trial expired (self-service via login screen)

⚠️ Upgrade plan EF is deployed but never tested with real money end-to-end
⚠️ Billing shows "pending_mandate" for all shops — no merchant has completed mandate
⚠️ Dashboard stats accurate for stamps/customers but no payment history
❌ Cannot change email address
❌ Cannot change shop name, city, plan details after enrollment
❌ Cannot manage multiple shops under one email
❌ Cannot export customer list
❌ Cannot set custom reward rules post-enrollment (fixed at enrollment: buy X get 1 free)
❌ No in-app messaging or WhatsApp integration (links open WhatsApp manually)

**Honest reliability: Core stamping workflow is solid. Billing UI is complete but all billing paths are untested with real Razorpay charges.**

---

## True Capacity Assessment

### What the system can handle RIGHT NOW

| Scenario | Verdict |
|---|---|
| 0–50 merchants, 0–500 customers | ✅ Comfortable. No architectural changes needed. |
| 50–200 merchants, 500–5,000 customers | ✅ Works. admin-data pagination handles it. DB is fine. |
| 200–500 merchants, 5,000–50,000 customers | ⚠️ Works but in-memory rate limiting degrades. Supabase free tier DB may hit limits. pg_cron suspend job still works. |
| 500–1,000 merchants | ⚠️ Upgrade Supabase to Pro (€25/month). Add Upstash Redis for rate limiting. Everything else scales. |
| 1,000+ merchants | ❌ Not ready. Needs: Upstash Redis, DB indexing audit, possibly Connection Pooler. |

### Specific bottlenecks in order of urgency

**#1 — No real payment has ever been processed.**
The entire billing infrastructure — webhook, payment recording, receipt emails — is built and correct, but the path `subscription.charged → payments table → receipt email` has never been triggered by a real Razorpay charge. The first billing cycle for Test Cafe hits on or around 24 June 2026. That's the first real test of money-handling code.

**#2 — In-memory rate limiting is per-EF-instance.**
`enroll-subscribe`, `reactivate-billing`, `merchant-reset-password` all use `ipStore = new Map()`. Under load Supabase spins multiple instances. Not a problem at current scale (5 shops). Becomes meaningful above ~200 concurrent enrollments/hour.

**#3 — Supabase free tier limits.**
Free: 500MB DB, 2M EF invocations/month. At 500 shops × 100 customer card loads/day = 50,000/day × 30 = 1.5M/month — approaching the limit. Upgrade to Pro (€25/month) well before 300 shops.

**#4 — pg_cron runs once per night.**
The suspension job runs at 00:30 IST. A trial that expired at 11 PM on Day 30 doesn't get suspended until 00:30 the following night — effectively 1-2 hours of grace. Not a problem, but merchants should know.

**#5 — One email per person.**
One owner email can have exactly one shop. Two outlets of the same shop? Second owner email needed. First merchant with two locations will hit this wall.

---

## Secrets & Config

| Secret | Set? | Used By |
|---|---|---|
| DATABASE_SERVICE_ROLE_KEY | ✅ | All EFs |
| ADMIN_JWT_SECRET | ✅ | admin-auth, admin-action, admin-data |
| MERCHANT_JWT_SECRET | ✅ | merchant-auth, merchant-api, upgrade-plan, etc. |
| RAZORPAY_KEY_ID | ✅ | enroll-subscribe, razorpay-webhook, etc. |
| RAZORPAY_KEY_SECRET | ✅ | All Razorpay API calls |
| RAZORPAY_WEBHOOK_SECRET | ✅ | razorpay-webhook (HMAC verification) |
| RAZORPAY_PLAN_STARTER | ✅ | enroll-subscribe, create-subscription |
| RAZORPAY_PLAN_PRO | ✅ | upgrade-plan |
| RAZORPAY_PLAN_PREMIUM | ✅ | upgrade-plan |
| RESEND_API_KEY | ✅ | send-email, trial-expiry-notifier, razorpay-webhook |
| ALERT_EMAIL | ✅ (support@primorewards.in) | trial-expiry-notifier, razorpay-webhook |
| SLACK_WEBHOOK_URL | ❌ Not set | Removed — using email instead |
| UPSTASH_REDIS_URL | ❌ Not set | Future — needed above 1000 merchants |

---

## Honesty Summary

**What's genuinely solid:**
The core loyalty loop — customer registers → merchant stamps → customer redeems — works and has real test data. The admin panel is reliable for shop management. Email infrastructure works (tested). Automation runs nightly. Security is sound (bcrypt, JWT, HMAC, server-side validation everywhere).

**What's never been proven:**
No merchant has completed a Razorpay mandate. No `subscription.charged` event has ever fired. The entire "billing converts" path is code-complete but production-untested. The plan upgrade feature is also code-complete but never tested end-to-end with real money.

**What's genuinely missing:**
Customers can't see their own history. Merchants can't update their settings. One email = one shop. No customer opt-out. No GST invoice. No downgrade flow. No multi-shop support.

**True state:** Pre-launch, test phase. Good enough to onboard your first 20–50 paying merchants safely. The first billing cycle (Test Cafe, ~24 June 2026) will be the real production test.
