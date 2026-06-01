# Primo Rewards — Build Roadmap
> What needs to be built, ranked by importance.
> Based on live system state as of 1 June 2026.

---

## TIER 1 — Critical (system breaks or loses money without these)

### 1. First billing cycle monitoring (build before 24 June 2026)
**Why it's #1:** Test Cafe's trial ends ~24 June. This is the first time real Razorpay charges will fire. If `subscription.charged` fails, the merchant gets charged but we have no record and they get no receipt. The reconcile-payments EF exists to catch this but has never been used. Admin needs to actively monitor on that date.

**What to do:**
- Set a calendar reminder for 24 June
- On that day, check: admin panel → Revenue tab → Razorpay Payment Log shows a row
- If not: run "Reconcile All" button, check Supabase EF logs for webhook errors
- No code to write. Just a process to follow.

**Risk if skipped:** Merchant charged but no receipt. Trust broken. ₹199 dispute.

---

### 2. send-email EF — missing `billing_cancelled` and `plan_upgraded` templates
**Why it's #2:** `razorpay-webhook` v31 calls `sendEmail('billing_cancelled', ...)` when a subscription is cancelled and `sendEmail('plan_upgraded', ...)` when a plan upgrade completes. The `send-email` EF does NOT have these templates in its `buildEmail()` switch. It will throw `Unknown template: billing_cancelled`. Merchant gets no notification when their subscription is cancelled.

**What to build:**
- In `send-email` v13: add `billing_cancelled` template (plain, compassionate — subscription cancelled, how to restart)
- In `send-email` v13: add `plan_upgraded` template (confirms new plan, new billing amount, effective date)
- Estimated: 1 hour

**Risk if skipped:** Silent failure on webhook → 500 logged → alert email fires to you, but merchant gets nothing.

---

### 3. Merchant settings — change email, phone, city
**Why it's #3:** A merchant cannot update any of their contact details after enrollment. If they change their phone number, their forgot-password flow breaks. If they change their email, support has to do it via SQL. This will happen in the first month of real merchants.

**What to build:**
- New `merchant-api` action: `update_settings` — accepts `{ owner_email?, owner_phone?, city? }`
- UI in merchant.html Settings tab: edit form with Save button
- Re-validate email uniqueness on update (can't take someone else's email)
- Estimated: 2–3 hours

**Risk if skipped:** First merchant with changed contact details needs SQL support forever.

---

### 4. pg_cron cleanup — abandoned plan upgrade subscriptions
**Why it's #4:** When a merchant initiates a plan upgrade, a new Razorpay subscription is created. If they never complete the mandate, `pending_plan_upgrade` sits in the DB forever and the new Razorpay subscription quietly exists in `created` state. After 7 days it should be cancelled and the pending flag cleared.

**What to build:**
- New EF: `cleanup-abandoned-upgrades` — finds shops with `pending_plan_upgrade` where `initiated_at` is older than 7 days, cancels the Razorpay subscription, clears the flag
- pg_cron: weekly job at Sunday 19:30 UTC that calls this EF via net.http_post
- Estimated: 1.5 hours

**Risk if skipped:** Orphaned Razorpay subscriptions accumulate. Not a money risk (they never charge unless authenticated) but creates dashboard clutter in Razorpay.

---

## TIER 2 — Important (first merchant complaints will come from these)

### 5. Customer stamp history view
**Rating: 8/10 urgency**

Customers currently see only their current stamp count and progress bar. They cannot see when they earned stamps, from which visits, or their redemption history. Any regular customer will ask "how many stamps did I earn this month?"

**What to build:**
- In `customer-card` EF: add `stamp_history` to response (last 20 stamps with date)
- In `primo-shop-engine-v5.html`: expandable "Stamp History" section below the card
- Estimated: 2 hours

---

### 6. Merchant reward rule customisation post-enrollment
**Rating: 7/10 urgency**

Reward rule (buy X, get 1 free) is set at enrollment and cannot be changed. The first merchant who wants to run a seasonal promotion or change their loyalty structure will be stuck.

**What to build:**
- New `merchant-api` action: `update_reward_rule`
- UI in merchant.html Settings tab: rule editor (buy number input, product name)
- Admin audit log entry for rule changes
- Estimated: 2 hours

---

### 7. Multi-shop per merchant email
**Rating: 7/10 urgency**

One owner email = one shop. A merchant with Bandra and Andheri outlets needs two emails. This will be the first real friction point for growing merchants.

**What to build:**
- Remove the email dedup constraint in `enroll-subscribe` OR make it a warning (not a blocker) for already-suspended/enrolled shops
- Option B (recommended): Add a `multi_shop_owner_id` concept — merchants can request linking under Supabase admin
- The full self-service version is complex; a manual process (admin creates second shop via SQL) is acceptable at < 50 merchants
- Estimated for manual-support version: 0 hours (process). For self-service: 4+ hours.

---

### 8. Plan downgrade self-service
**Rating: 6/10 urgency**

Upgrade exists. Downgrade doesn't. Same architecture (next-cycle subscription swap). Merchants on Pro who want to go back to Starter will call support.

**What to build:**
- `downgrade-plan` EF — same logic as `upgrade-plan` but validates new plan is lower tier
- Merchant dashboard: "⬇ Downgrade plan" button alongside upgrade
- Webhook: handle downgrade's `subscription.authenticated` the same as upgrade
- Estimated: 2 hours (copy-paste from upgrade-plan with tier direction reversed)

---

### 9. WhatsApp stamp notification to customer
**Rating: 6/10 urgency**

After giving a stamp, the merchant currently clicks a WhatsApp link to manually open a pre-filled message. There is no automatic notification. Customers forget they earned a stamp.

**What to build:**
- Requires WhatsApp Business API account (Meta approval, ~2 weeks)
- OR use 360Dialog / Twilio (pay-per-message, faster setup)
- After setup: `merchant-api` stamp action triggers WhatsApp message: "You got a stamp at [Shop]! 🎉 You now have X/11."
- Estimated: 3–4 hours after WhatsApp Business API is approved

**Dependency:** External API approval. Not code-blocked.

---

## TIER 3 — Compliance & Scale (needed before 100 shops)

### 10. DPDP data deletion (customer opt-out)
**Rating: 5/10 urgency**

India's Digital Personal Data Protection Act 2023 gives customers the right to request erasure of their data. Currently: manual SQL only. Acceptable at < 50 shops. Required as a process (even if manual) before onboarding real customers at scale.

**What to build:**
- Short-term (now): Document the SQL deletion process in an internal runbook
- Medium-term (before 100 shops): Self-service deletion form at primorewards.in/delete-my-data — submits request to support@primorewards.in, admin runs the SQL
- Long-term (500+ shops): Admin panel button "Delete customer data" that runs the deletion and logs it
- Estimated for runbook: 0 hours. For self-service form: 1 hour.

---

### 11. GST invoice for subscription payments
**Rating: 5/10 urgency**

Merchants need a tax invoice for their subscription to claim input GST credit. Razorpay can auto-generate invoices but they need your GSTIN and legal entity name set up correctly in Razorpay Dashboard.

**What to build:**
- In Razorpay Dashboard: set up billing details (GSTIN, legal name, address) under your account settings
- Razorpay auto-sends invoice on each charge — no code needed
- Estimated: 30 minutes in Razorpay dashboard

---

### 12. Upstash Redis for global rate limiting
**Rating: 4/10 urgency — skip until 1,000+ live merchants**

Current in-memory `ipStore` is per-EF-instance. Under load Supabase spins multiple instances and rate limits don't share state. Not a real problem below 200 shops. Already documented in REMAINING-BUILD.md.

**What to build when ready:**
- Create Upstash Redis account (free tier: 10,000 req/day)
- Add `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN` to Supabase secrets
- Replace `ipStore = new Map()` in: `enroll-subscribe`, `reactivate-billing`, `merchant-reset-password`
- Estimated: 15 min per EF × 3 = 45 minutes total

---

### 13. Supabase upgrade to Pro
**Rating: 4/10 urgency — needed at ~300 shops**

Free tier: 500MB DB, 2M EF invocations/month. At 300 active shops with 50 daily card loads each, you'll hit 300 × 50 × 30 = 450,000 EF calls/month comfortably under limit. But DB size grows. Upgrade to Pro (€25/month) at ~300 shops before DB hits 400MB.

**What to do:** Supabase Dashboard → Settings → Billing → Upgrade. No code changes.

---

## TIER 4 — Future Wants (build when merchants ask)

### 14. Customer self-service portal
**Rating: 3/10 urgency now**

A dedicated page where customers can: see all shops they're enrolled in, view full stamp history, update their phone number, delete their data.

**Complexity:** Medium. Requires cross-shop customer identity (currently phone is the only identifier, not a global ID).

---

### 15. Analytics improvements
**Rating: 3/10 urgency now**

Current analytics: basic stamp/redemption counts. Missing: peak visit hours, customer return rate, average stamps per visit, cohort analysis (how many customers from Month 1 are still active?).

**Complexity:** Medium. DB queries exist, UI needed.

---

### 16. Multiple reward tiers / expiring stamps
**Rating: 3/10 urgency now**

Some merchants want: buy 5 get 1, buy 10 get 2. Or stamps that expire after 90 days. Current system is fixed: buy X, get 1, stamps never expire.

**Complexity:** Medium–High. Schema changes to stamps table, new EF logic.

---

### 17. Merchant customer export (CSV)
**Rating: 3/10 urgency now**

Merchant cannot export their customer list. "Give me all customers who visited in the last 30 days" is a natural ask for any email marketing campaign.

**Complexity:** Low. One new `merchant-api` action + UI button.

---

### 18. Custom stamp card design
**Rating: 2/10 urgency now**

All merchants get the same gold coin loyalty card. Premium merchants may want branded colours, logo, etc.

**Complexity:** High. Significant frontend changes to `primo-shop-engine-v5.html`.

---

### 19. Referral system (customer refers friend)
**Rating: 2/10 urgency now**

Customer shares a referral link. New customer who registers through it gets bonus stamps. Merchant gets insight into referral traffic.

**Complexity:** High. New table, new EF, UI changes.

---

### 20. WhatsApp Business Cloud API (automated messages)
**Rating: 2/10 urgency now — blocked on Meta approval**

Replace manual "click to WhatsApp" links with automatic stamp notifications, redemption confirmations, and re-engagement messages for inactive customers.

**Complexity:** Medium after API approval. 2 weeks Meta review time.

---

## Build Order Recommendation

If you onboard 5 real merchants this month:
1. **Immediately:** Fix `send-email` missing templates (#2) — takes 1 hour, prevents silent failures
2. **Before 24 June:** Watch first billing cycle (#1) — no code, just monitoring
3. **Month 1:** Merchant settings page (#3) — first thing real merchants will ask for
4. **Month 1:** Customer stamp history (#5) — customers will ask "where are my stamps?"
5. **Month 2:** pg_cron upgrade cleanup (#4) + plan downgrade (#8)
6. **Month 3:** WhatsApp Business API application + multi-shop support (#7, #9)
7. **At 300 shops:** Upstash Redis (#12) + Supabase Pro (#13)
