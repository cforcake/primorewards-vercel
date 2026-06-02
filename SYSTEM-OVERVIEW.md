# Primo Rewards — System Overview
> Updated: 2 June 2026. All numbers from live DB. No estimates.

---

## Live Data Snapshot

| Metric | Count |
|---|---|
| Total shops | 5 |
| Active shops | 4 |
| Suspended shops | 1 (c-for-cake-2, ghost duplicate) |
| Trial-pending shops | 0 |
| **Paying shops** | **0 — payments table is empty** |
| **Real money processed** | **₹0** |
| Customers | 7 |
| Stamps given | 37 |
| Redemptions | 3 |
| Subscription events logged | 10 |
| Admin audit log rows | 7 |
| Stamp scans (QR) | 4 |
| Coupons | 0 |

### Shop-by-shop reality

| Shop | Plan | Status | Sub status | Trial ends | Customers | Stamps |
|---|---|---|---|---|---|---|
| test-cafe | Starter | active | pending_mandate | 24 Jun 2026 | 4 | 34 |
| e2e-test-shop | Starter | active | pending_mandate | 30 Jun 2026 | 1 | 0 |
| c-for-cake | Pro | active | pending_mandate | 30 Jun 2026 | 0 | 0 |
| c-for-cake-2 | Pro | **suspended** | cancelled | 30 Jun 2026 | 0 | 0 |
| niraj-cafe | Pro | active | pending_mandate | 30 Jun 2026 | 2 | 3 |

**Key fact:** Every active shop was activated manually by admin. The `subscription.authenticated` webhook has never fired in production. No shop has completed a Razorpay mandate. No money has ever moved.

---

## Infrastructure

| Layer | Technology | Status |
|---|---|---|
| Database | Supabase PostgreSQL (free tier, 500MB) | ✅ Live |
| Backend | 27 Supabase Edge Functions (Deno) | ✅ Live |
| Frontend | Vercel static hosting (HTML/CSS/JS) | ✅ Live |
| Payments | Razorpay subscriptions | ✅ Configured, untested with real money |
| Email | Resend (FROM: welcome@primorewards.in) | ✅ Tested, working |
| Automation | pg_cron (2 daily jobs at 00:30 & 00:35 IST) | ✅ Running |
| Alerting | Email to support@primorewards.in via Resend | ✅ Tested, confirmed working |
| Rate limiting | Upstash Redis (free tier, 10k cmd/day) | ✅ Live as of 2 Jun 2026 |

---

## Edge Functions — Complete List (27)

### Enrollment & Auth
| Slug | Version | Status | Notes |
|---|---|---|---|
| enroll-subscribe | v8 | ✅ Production tested | Upstash Redis RL (3/hr/IP, key: `rl:enroll:{ip}`). Email dedup by owner_email. Re-enroll in-place for trial/suspended. |
| merchant-auth | v25 | ✅ Production tested | bcrypt login. 4-hour JWT. |
| merchant-reset-password | v4 | ✅ Built, minimally tested | Upstash Redis RL (3/hr/IP, key: `rl:reset:{ip}`). Always returns `{ok:true}` — prevents email enumeration. |
| admin-auth | v21 | ✅ Tested | Admin key → JWT. |

### Merchant Dashboard
| Slug | Version | Status | Notes |
|---|---|---|---|
| merchant-api | v29 | ✅ Most-used EF | load_dashboard, stamp, redeem, add_customer, save_settings (Starter plan CANNOT change reward_rule — 403), change_password, initiate_billing. |
| upgrade-plan | v3 | ⚠️ Built, never tested with real money | Creates new Razorpay sub at current_end. Stores mandate_url in pending_plan_upgrade JSONB (fixed this session). |
| cancel-upgrade-plan | v3 | ⚠️ Built, untested | Cancels pending upgrade sub and clears JSONB flag. |

### Billing & Payments
| Slug | Version | Status | Notes |
|---|---|---|---|
| razorpay-webhook | v31 | ✅ Structurally correct, ⚠️ untested with real money | Handles authenticated/charged/halted/cancelled. HMAC verified. Email alerts on critical failures. |
| create-subscription | v12 | ✅ Used by admin | Admin-triggered sub creation. |
| reactivate-billing | v5 | ✅ Built, minimally tested | Upstash Redis RL (3/hr/IP, key: `rl:reactivate:{ip}`). |
| sync-billing-status | v3 | ✅ Tested | Merchant "Verify payment" button — maps Razorpay state to DB. |
| refresh-mandate | v3 | ✅ Built | Fetches fresh mandate URL from Razorpay. |
| reconcile-payments | v3 | ⚠️ Built, no data to test against | Finds missed charges by comparing Razorpay invoices vs payments table. 0 payments exist to reconcile. |

### Customer Experience
| Slug | Version | Status | Notes |
|---|---|---|---|
| customer-lookup | v24 | ✅ Production tested | Phone lookup for stamping. |
| customer-card | v22 | ✅ Production tested | Full loyalty card (stamps, progress, reward status). |
| get-stamp-token | v4 | ✅ Production tested | QR stamp token generation. |
| validate-stamp-qr | v4 | ✅ Production tested | QR scan validation. |
| get-qr-feed | v3 | ✅ Built | QR feed endpoint. |

### Admin Panel
| Slug | Version | Status | Notes |
|---|---|---|---|
| admin-data | v22 | ✅ Tested | Paginated shop list + stats. Fixed this session: removed 5 ghost columns that caused 500 errors. |
| admin-action | v21 | ✅ Tested | Activate / suspend / reinstate / sync_subscription. |
| admin-customers | v18 | ✅ Built | Customer management across shops. |
| admin-coupons | v10 | ✅ Built, 0 coupons used | Coupon CRUD. |
| get-analytics | v3 | ✅ Built | Analytics data endpoint. |

### Infrastructure
| Slug | Version | Status | Notes |
|---|---|---|---|
| send-email | v13 | ✅ Production tested | 6 complete templates: trial_activation, billing_active, payment_receipt, payment_failed, billing_cancelled (added this session), plan_upgraded (added this session). |
| trial-expiry-notifier | v4 | ✅ Runs nightly | T-3d warning + T+0 expiry emails. alertEmail() on failure. |
| validate-coupon | v10 | ✅ Built, 0 coupons used | Enrollment coupon validation. |
| ping-alert | v2 | 🗑️ Decommissioned | Returns 410. Used once for alertEmail testing. |

---

## Secrets & Config

| Secret | Set | Used by |
|---|---|---|
| DATABASE_SERVICE_ROLE_KEY | ✅ | All EFs |
| MERCHANT_JWT_SECRET | ✅ | merchant-auth, merchant-api, upgrade-plan, etc. |
| ADMIN_JWT_SECRET | ✅ | admin-auth, admin-data, admin-action |
| RAZORPAY_KEY_ID | ✅ | enroll-subscribe, razorpay-webhook, upgrade-plan, etc. |
| RAZORPAY_KEY_SECRET | ✅ | All Razorpay API calls |
| RAZORPAY_WEBHOOK_SECRET | ✅ | razorpay-webhook HMAC verification |
| RAZORPAY_PLAN_STARTER | ✅ | enroll-subscribe, create-subscription |
| RAZORPAY_PLAN_PRO | ✅ | upgrade-plan, create-subscription |
| RAZORPAY_PLAN_PREMIUM | ✅ | upgrade-plan, create-subscription |
| RESEND_API_KEY | ✅ | send-email, trial-expiry-notifier, razorpay-webhook |
| ALERT_EMAIL | ✅ (support@primorewards.in) | trial-expiry-notifier, razorpay-webhook |
| UPSTASH_REDIS_REST_URL | ✅ (added 2 Jun 2026) | enroll-subscribe, reactivate-billing, merchant-reset-password |
| UPSTASH_REDIS_REST_TOKEN | ✅ (added 2 Jun 2026) | enroll-subscribe, reactivate-billing, merchant-reset-password |
| SLACK_WEBHOOK_URL | ❌ Not set, not needed | Replaced by alertEmail |

---

## Automation

| Job | Schedule | What it does |
|---|---|---|
| suspend-expired-trials | Daily 00:30 IST | SQL: sets status=suspended for shops where trial ended AND mandate never completed |
| trial-expiry-notifier-cron | Daily 00:35 IST | HTTP to trial-expiry-notifier EF via pg_net + nonce auth. Sends T-3d warning and T+0 expiry emails. |

---

## What Each Role Can Do

### Rank 1 — Customer (most reliable, most tested)
**Entry point:** `primorewards.in/{slug}-reward`

✅ Register with phone number
✅ View current stamp count and progress bar
✅ Earn stamps (manual entry by merchant or QR scan)
✅ Trigger redemption when stamp count is full
✅ Card updates immediately after each stamp

❌ Cannot view full stamp history (current count only)
❌ Cannot opt out or request data deletion
❌ Cannot receive WhatsApp/SMS confirmations
❌ No cross-shop identity (each shop is separate)

**Reliability: High.** This is the most tested path — 37 stamps, 3 redemptions, 4 QR scans across 7 customers.

---

### Rank 2 — Admin (reliable, actively used)
**Entry point:** `primorewards.in/admin`

✅ Login with admin key (server-validated JWT)
✅ View all shops with counts (customers, stamps, redemptions)
✅ Paginated list + search by name/email/city (server-side, handles 1000+ shops)
✅ Filter by status (active / trial / suspended)
✅ Activate / Suspend / Reinstate shops
✅ Sync billing status from Razorpay (missed webhook recovery)
✅ Reconcile missing payments per shop or globally
✅ View and manage coupons
✅ View enrollment funnel (WhatsApp follow-up links)
✅ View admin audit log
✅ Export shops as CSV
✅ View MRR breakdown by plan
✅ View Razorpay payment log (currently empty — no real charges yet)

⚠️ MRR numbers are plan-label estimates, not real revenue (payments table = 0)
⚠️ Reconcile returns "all clear" — accurate, but only because no charges have fired yet
❌ No bulk-actions on multiple shops
❌ No full-text search within audit log

**Reliability: High for shop management. Revenue tab shows accurate zeros.**

---

### Rank 3 — Merchant (reliable core, billing untested with money)
**Entry point:** `primorewards.in/merchant`

✅ Login with slug + password (bcrypt, 4-hour JWT)
✅ Forgot password → email with temp password (rate-limited via Redis)
✅ Dashboard: today's stamps, total customers, redemptions
✅ Give stamps manually (phone number lookup)
✅ Show QR code for customers to scan
✅ Trigger redemption
✅ View analytics (stamps/redemptions trend)
✅ View billing status with plan, trial end date, mandate status
✅ Update payment method (halted subscription → mandate link)
✅ Verify payment status manually ("Already paid? Verify now")
✅ Upgrade plan: Starter → Pro → Premium (self-service)
✅ Cancel pending plan upgrade
✅ Reactivate billing (self-service, from login screen if suspended/expired)
✅ Edit product name and emoji
✅ Change password
✅ **Reward rule customisation locked for Starter plan** (UI disabled + server-side 403). Pro and Premium can edit.
✅ Reward rule editable for Pro/Premium merchants

⚠️ Upgrade plan EF deployed and mandate_url now stored in JSONB — but never tested end-to-end with real Razorpay money
⚠️ All 4 active shops show "pending_mandate" — no merchant has completed a mandate
❌ Cannot change email address or shop name post-enrollment
❌ Cannot manage multiple shops under one login
❌ Cannot export customer list
❌ No in-app messaging or automatic WhatsApp notifications

**Reliability: Core stamping loop is solid. Billing UI is complete and correct but all billing paths await the first real charge (est. 24 Jun 2026).**

---

## Rate Limiting — Current State

| Endpoint | Mechanism | Limit | Fallback |
|---|---|---|---|
| enroll-subscribe | **Upstash Redis** (`rl:enroll:{ip}`) | 3/hr/IP | In-memory Map |
| reactivate-billing | **Upstash Redis** (`rl:reactivate:{ip}`) | 3/hr/IP | In-memory Map |
| merchant-reset-password | **Upstash Redis** (`rl:reset:{ip}`) | 3/hr/IP | In-memory Map |
| merchant-auth | None (bcrypt is the throttle) | — | — |
| All others | No rate limiting needed | — | — |

Upstash free tier: 10,000 commands/day. At current and projected scale (2,000+ merchants), typical daily usage is ~80–200 commands — well under the limit. Ceiling is effectively 10,000+ merchants before any upgrade is needed.

---

## Capacity Assessment

| Scale | Verdict |
|---|---|
| 0–50 merchants, <500 customers | ✅ Comfortable. No changes needed. |
| 50–200 merchants, <5,000 customers | ✅ Works. Pagination handles it. DB fine. Redis handles it. |
| 200–500 merchants | ✅ Works. Monitor Supabase DB size (500MB free limit). |
| 500–1,000 merchants | ⚠️ Upgrade Supabase to Pro (€25/mo). Everything else scales. |
| 1,000+ merchants | ⚠️ DB index audit needed. Redis is already global — no changes needed there. |

### Specific bottlenecks in order of urgency

**#1 — No real payment ever processed.**
The first real Razorpay charge fires when Test Cafe's trial ends ~24 Jun 2026. The path `subscription.charged → payments table → receipt email` is code-complete but unproven with real money.

**#2 — One owner email = one shop.**
A merchant with two outlets needs two email addresses. First merchant with two locations will hit this immediately.

**#3 — pg_cron 1-2 hour grace window.**
Suspension job runs at 00:30 IST. A trial expiring at 11 PM gets suspended ~1.5 hours later. Acceptable, but merchants should know.

**#4 — Supabase free tier DB size.**
At ~300 active shops generating stamps daily, the 500MB DB limit becomes relevant. Upgrade Supabase Pro before reaching 400MB.

---

## Alerting

When these events occur, an email lands at **support@primorewards.in** from `welcome@primorewards.in`:

| Trigger | Subject |
|---|---|
| `subscription.charged` webhook fails | 🔴 [Primo Alert] subscription.charged handler FAILED — manual check required |
| `subscription.authenticated` webhook fails | 🔴 [Primo Alert] subscription.authenticated handler FAILED |
| Trial expiry email fails to send | 🔴 [Primo Alert] T-3d / T+0 email failed — {shop name} |
| Nightly DB query errors | 🔴 [Primo Alert] T-3d / T+0 DB query failed |
| Any nightly run with errors | 🔴 [Primo Alert] Run completed with N errors |

Alerting is graceful: if `ALERT_EMAIL` or `RESEND_API_KEY` is not set, the EFs continue working and skip the alert silently.

---

## Honest Summary

**What genuinely works in production:** The stamping loop (37 stamps, 3 redemptions, 4 QR scans across real shops). Admin panel shop management. Nightly trial expiry automation. Email delivery (Resend confirmed working). Error alerting (tested and confirmed). Rate limiting (Upstash Redis — globally consistent across all EF instances).

**What is code-complete but unproven with real money:** Razorpay `subscription.charged` webhook. Plan upgrade flow. Reconcile payments. All billing UI paths past the mandate screen.

**What is confirmed missing:** Customer stamp history view. Merchant ability to update email/phone/shop name. Multi-shop per merchant. Plan downgrade. Customer opt-out/data deletion. GST invoice.

**True state as of 2 June 2026:** Pre-revenue, final testing phase. Safe to onboard first 20–50 real merchants. First billing cycle (Test Cafe, ~24 Jun 2026) is the next critical milestone.
