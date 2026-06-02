# Primo Rewards — Build Roadmap
> Updated: 2 June 2026. Ranked by urgency. Reflects all changes built to date.

---

## What Was Completed in This Build Session (2 Jun 2026)

These items are now DONE and removed from the active roadmap:

| ✅ Done | Detail |
|---|---|
| Admin panel JS parse errors fixed | Stray `}` in loadDashboard + orphaned comment before syncSubscription — both fixed |
| admin-data ghost column bug | 5 non-existent columns removed from SHOP_COLS — was causing 500 on every admin login |
| Email alerting | trial-expiry-notifier v4 + razorpay-webhook v31 use alertEmail() via Resend. ALERT_EMAIL=support@primorewards.in confirmed working |
| send-email missing templates | billing_cancelled + plan_upgraded added to v13. Was throwing "Unknown template" silently on webhook events |
| upgrade-plan mandate_url fix | mandate_url now stored in pending_plan_upgrade JSONB. Page reload no longer shows "check email" |
| Reward rule plan lock | Starter plan: sfBuy/sfGet disabled in UI + client guard + server-side 403 in merchant-api. Pro/Premium: editable |
| Upstash Redis rate limiting | Deployed to enroll-subscribe v8, reactivate-billing v5, merchant-reset-password v4. Keys: `rl:{endpoint}:{ip}`, TTL 3600s, limit 3/hr. Graceful fallback to in-memory if Redis unavailable |

---

## TIER 1 — Critical (do before onboarding real merchants)

### 1. First billing cycle — active monitoring (before 24 Jun 2026)
**Urgency: 10/10**

Test Cafe's trial ends 24 Jun 2026. This is the first time `subscription.charged` fires in production and real money moves. The payment path is code-complete but has never been exercised.

**What to do — no code required:**
- On 24 Jun, log into admin panel → Revenue tab → check Razorpay Payment Log shows a new row
- If missing: click "Reconcile All" (🔍 icon in header) — this queries Razorpay invoices and inserts any missing records
- If reconcile finds nothing: check Supabase EF logs for razorpay-webhook errors
- If webhook failed: check ALERT email at support@primorewards.in — should have received a 🔴 alert
- If alert also missing: check Supabase Edge Function logs manually for that hour

**Risk if skipped:** Merchant charged ₹199 but no receipt email. Trust broken on day one of real billing.

---

### 2. Merchant settings — edit email, phone, city
**Urgency: 8/10**

A merchant cannot update their own contact details post-enrollment. If they change their phone number, the forgot-password flow breaks. If they move cities, the admin panel shows stale data. First real merchant who changes their number needs manual SQL from you.

**What to build:**
- New `merchant-api` action: `update_contact` — accepts `{ owner_email?, owner_phone?, city? }`
- Validate email uniqueness on update (can't steal another merchant's email)
- UI in merchant.html Settings tab: editable fields with Save Contact button below the password section
- Estimated: 2–3 hours

---

### 3. pg_cron cleanup — abandoned plan upgrade subscriptions
**Urgency: 7/10**

When a merchant clicks "Upgrade to Pro," a new Razorpay subscription is created immediately. If they never complete the mandate, `pending_plan_upgrade` sits in the DB and the Razorpay subscription quietly exists in `created` state indefinitely. First real upgrade attempt that gets abandoned will create orphaned subs in Razorpay dashboard.

**What to build:**
- New EF: `cleanup-abandoned-upgrades`
  - Finds shops where `pending_plan_upgrade IS NOT NULL` and `initiated_at < NOW() - INTERVAL '7 days'`
  - Calls Razorpay to cancel each orphaned subscription
  - Clears `pending_plan_upgrade` to null
  - Logs to `subscription_events`
- New pg_cron job: Sunday 19:30 UTC (weekly) — calls the EF via net.http_post
- Estimated: 1.5 hours

---

## TIER 2 — Important (first merchant complaints will come from these)

### 4. Customer stamp history view
**Urgency: 8/10**

Customers see only their current stamp count. They cannot see when they earned stamps, how many cycles they've completed, or their redemption history. Any regular customer will ask this within the first week of using the app.

**What to build:**
- In `customer-card` EF: add `stamp_history` array to response (last 20 stamps with date + cycle)
- In `primo-shop-engine-v5.html`: expandable "Stamp History" section below the stamp card with dates and cycle numbers
- Estimated: 2 hours

---

### 5. Plan downgrade self-service
**Urgency: 7/10**

Upgrade exists (v3). Downgrade does not. Same architecture — next-cycle subscription swap, webhook confirmation. Merchants on Pro who want Starter will call support.

**What to build:**
- `downgrade-plan` EF — same pattern as upgrade-plan but validates new plan is a lower tier and price
- Block downgrade if the merchant has a reward rule that requires Pro (non-default buy/get values)
- Merchant UI: "⬇ Downgrade" option alongside upgrade in Settings → Billing
- Webhook: `subscription.authenticated` already handles plan swaps (upgrade and downgrade use same code path via notes.source)
- Estimated: 2 hours

---

### 6. Merchant reward rule customisation post-enrollment
**Urgency: 6/10**

Pro and Premium merchants can now edit their reward rule (buy X get 1). This is already built and gated by plan. The remaining gap: there is no way to customise the reward rule unless the merchant logs into the Settings tab — no guided first-run experience, no explanation of what changing the rule means for existing customers who are mid-cycle.

**What to build:**
- In-app note when saving a changed reward rule: "⚠️ Changing the rule affects new cycles only. Customers already partway through a cycle keep their stamps."
- No new EF needed — merchant-api v29 already handles it correctly
- Estimated: 30 minutes (UI copy only)

---

### 7. Multi-shop per merchant email (two outlets)
**Urgency: 6/10**

One owner email = one shop. A merchant with Bandra and Andheri outlets needs two separate email accounts. This will be the first structural friction for any growing merchant.

**Short-term (manual, 0 hours):** Admin creates second shop with a variant email (e.g. owner+andheri@gmail.com). Not ideal but workable at <20 merchants.

**Proper fix (medium-term):**
- Add `owner_group_id` column to shops table
- Allow multiple shops with same owner_email if admin explicitly links them
- Merchant dashboard shows a shop switcher dropdown
- Estimated: 4–5 hours for proper version

---

## TIER 3 — Compliance & Scale (needed before 100 shops)

### 8. DPDP data deletion (customer opt-out)
**Urgency: 5/10**

India's Digital Personal Data Protection Act 2023 gives customers the right to data erasure. Currently only possible via manual SQL. Not legally required to be self-service, but should have a documented process.

**Short-term (now, 0 hours):** Create an internal runbook document: SQL to delete a customer (DELETE FROM stamps, redemptions, customers WHERE full_phone = ? AND shop_id = ?).

**Medium-term (before 100 shops):** Self-service form at primorewards.in/delete-my-data. Customer enters phone + shop name. Sends a deletion request to support@primorewards.in. Admin runs the SQL.

**Long-term (before 500 shops):** Admin panel "Delete customer data" button that runs deletion and logs to audit_log.

---

### 9. GST invoice for subscription payments
**Urgency: 5/10**

Merchants need a GST tax invoice to claim input credit. Razorpay can auto-generate compliant invoices but requires your GSTIN and legal entity details to be configured in Razorpay Dashboard.

**What to do (30 minutes, no code):**
- Log into Razorpay Dashboard → Settings → Business Profile → add GSTIN and legal entity name
- Razorpay will automatically attach a GST invoice to every successful subscription charge
- No EF changes needed

---

### 10. WhatsApp Business API — automated stamp notifications
**Urgency: 4/10 — blocked on Meta approval**

Currently merchants manually click a pre-filled WhatsApp link after giving a stamp. No automatic notification reaches the customer. Customers forget they earned a stamp.

**What to build after API approval:**
- After each successful stamp in `merchant-api`, fire a WhatsApp template message: "You got a stamp at {shop}! 🎉 You now have {count}/{buy} stamps."
- After redemption: "Your reward at {shop} was redeemed! ✅ Start collecting again."
- Requires: WhatsApp Business API (Meta review: ~2 weeks) OR a reseller like 360Dialog/Twilio

**Estimated:** 3–4 hours of code after API is approved.

---

### 11. Supabase upgrade to Pro
**Urgency: 4/10 — needed at ~300 shops**

Free tier: 500MB DB, 2M EF invocations/month. At 300 shops × 50 card loads/day = 15,000/day × 30 = 450,000/month — within limits but DB size will grow. Upgrade before reaching 400MB.

**What to do:** Supabase Dashboard → Settings → Billing → Upgrade. No code changes. ~€25/month.

---

## TIER 4 — Future Features (build when merchants ask)

### 12. Customer self-service portal
**Urgency: 3/10**
A dedicated page where customers can view all shops they're enrolled in, see stamp history, update phone, request data deletion. Requires cross-shop customer identity (currently phone-number-only per shop).

### 13. Analytics improvements
**Urgency: 3/10**
Current: basic stamp/redemption counts. Missing: peak visit hours, customer return rate, average stamps per visit, cohort retention analysis.

### 14. Merchant customer export (CSV)
**Urgency: 3/10**
Merchant cannot download their customer list. One new merchant-api action + UI button. Easy to build, low risk. Estimated: 1 hour.

### 15. Multiple reward tiers or expiring stamps
**Urgency: 2/10**
Some merchants want tiered rewards or stamps that expire after 90 days. Schema changes required. Not needed until a merchant specifically asks.

### 16. Custom stamp card branding
**Urgency: 2/10**
All merchants get the same gold coin card. Premium merchants may want their logo and brand colours. Significant frontend work to primo-shop-engine-v5.html.

### 17. Referral system
**Urgency: 2/10**
Customer shares a link. New customer who registers through it gets bonus stamps. New table, new EF, UI changes. Interesting but not needed at current scale.

---

## Recommended Build Order (if you onboard first merchants this month)

**Do immediately:**
1. GST invoice setup in Razorpay Dashboard (#9) — 30 minutes, no code, zero risk
2. DPDP runbook (#8) — write the SQL, keep it in notes

**Do before 24 Jun 2026:**
3. Set up calendar reminder for Test Cafe billing day. Have admin panel open.

**Do in July (after first billing cycle confirms):**
4. Merchant contact update UI (#2) — real merchants will ask for this within weeks
5. pg_cron upgrade cleanup (#3) — before first real upgrade attempt
6. Customer stamp history (#4) — customers ask immediately

**Do in August:**
7. Plan downgrade (#5) + reward rule in-app note (#6)
8. Multi-shop email support (#7) — when first merchant with 2 outlets asks
9. WhatsApp Business API application (takes 2 weeks to approve, start early)

**At 300 shops:**
10. Supabase Pro upgrade (#11)
11. Begin customer self-service portal (#12)
