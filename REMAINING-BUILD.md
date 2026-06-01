# Primo Rewards — Remaining Build Queue

> Start every new session by reading BUILD-STATE.md first, then this file.
> Build in the order listed. Each section is self-contained.

---

## Build Order

| # | Feature | Effort | Priority |
|---|---|---|---|
| 1 | Payment reconciliation (Point 5) | 1–2 hrs | Before first billing cycle |
| 2 | Slack error alerting (Point 7) | 2 hrs | Before first 5 paying merchants |
| 3 | Plan upgrade self-service | 3–4 hrs | Before first upgrade request |
| — | Upstash Redis rate limiting | — | After 1000+ live merchants |

---

## 1 — Payment Reconciliation (Point 5)

### Why
`razorpay-webhook` `handleCharged` inserts a row into `payments` and sends
a receipt email. If Supabase is briefly down when Razorpay fires that webhook,
the charge still happens on Razorpay's side but our DB has no record and the
merchant gets no email. Razorpay retries 3 times over 24 hours — but if all
retries miss, we're blind.

### How it works
Razorpay subscription objects expose `paid_count` — the total number of
successful charges. Our `payments` table has one row per charge. Comparing
these two numbers per-shop reveals any gap instantly without iterating
individual payment objects.

### What to build

#### New EF: `reconcile-payments`
- Auth: `X-Admin-Token` (same as admin-action, admin-data)
- No request body needed
- Algorithm:
  1. Query `shops` for all `status='active'` rows with a `razorpay_subscription_id`
  2. For each shop, call `GET /v1/subscriptions/{id}` → read `paid_count`
  3. Count rows in `payments` where `shop_id = shop.id`
  4. If `paid_count > db_count`:
     - Call `GET /v1/payments?subscription_id={id}&count=20`
     - Insert missing `payments` rows (no email — charge already happened,
       sending a receipt now would confuse the merchant)
     - Log to `subscription_events` with event_type `payment_reconciled`
  5. Return `{ checked, discrepancies_found, inserted, details[] }`
- Run shops in parallel (Promise.all) but cap at 20 concurrent to avoid
  Razorpay rate limits

#### Admin panel update: `primo-admin-v2.html`
- Add a "🔄 Reconcile Payments" button to the Revenue tab
  above the Razorpay Payment Log section
- On click: call `sbEdge('reconcile-payments', {})`
- Show result in a toast: "✓ Checked 12 shops, 1 missing payment inserted"
  or "✓ All payments in sync"

### Files changed
- New EF: `reconcile-payments` v1
- Updated: `primo-admin-v2.html` (one button + one function)
- GitHub push required: `primo-admin-v2.html`

### Does NOT touch
- `razorpay-webhook` (no change to live event handling)
- `payments` schema (no migration needed)
- `shops` schema (no migration needed)

---

## 2 — Slack Error Alerting (Point 7)

### Why
pg_cron silently fails, Resend rejects a batch, a Razorpay webhook errors —
none of these generate any notification. You find out when a merchant calls.

### Architecture: Dedicated `alert-error` EF (hub pattern)
Rather than embedding Slack code in every EF, one dedicated EF owns
the Slack call. Other EFs call it fire-and-forget with one line:

```typescript
fetch(`${EDGE_BASE}/alert-error`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-internal-key': SERVICE_KEY },
  body: JSON.stringify({ source: 'trial-expiry-notifier', message: 'X emails failed', context: { errors: 3 } }),
}).catch(() => {}); // never block on alerting
```

This means: changing the alerting destination (e.g., from Slack to PagerDuty)
is one EF update, zero changes to all callers.

### What to build

#### Prereq: Add Supabase secret
```
SLACK_WEBHOOK_URL = https://hooks.slack.com/services/XXX/YYY/ZZZ
```
User sets this manually in Supabase → Settings → Edge Functions → Secrets.

#### New EF: `alert-error` v1
- Auth: `x-internal-key = DATABASE_SERVICE_ROLE_KEY`
- Input: `{ source: string, message: string, severity?: 'warning'|'error', context?: object }`
- Builds a Slack block message with:
  - 🔴 for error, ⚠️ for warning
  - Source EF name
  - Message
  - Context as JSON code block (truncated to 500 chars)
  - Timestamp (IST)
- POST to `SLACK_WEBHOOK_URL`
- Always returns `{ ok: true }` (never propagates Slack errors to callers)
- If `SLACK_WEBHOOK_URL` is not set: logs to console only (graceful degradation)

#### Updated EF: `trial-expiry-notifier` v3
- At the end of the run, if `errors > 0`:
  ```typescript
  fetch(`${EDGE_BASE}/alert-error`, {
    body: JSON.stringify({
      source: 'trial-expiry-notifier',
      message: `${errors} email(s) failed to send`,
      severity: 'warning',
      context: { warning_sent: warnSent, expiry_sent: expirySent, errors },
    }),
  }).catch(() => {});
  ```
- Zero other changes

#### Updated EF: `razorpay-webhook` v28
- In the main `try/catch` that wraps the event handler:
  ```typescript
  } catch (err) {
    console.error(`[webhook] ${eventName} error:`, err);
    fetch(`${EDGE_BASE}/alert-error`, {
      body: JSON.stringify({
        source: 'razorpay-webhook',
        message: `Unhandled error on ${eventName}`,
        severity: 'error',
        context: { event: eventName, error: String(err) },
      }),
    }).catch(() => {});
    return new Response('Internal server error', { status: 500 });
  }
  ```
- Zero other changes to webhook logic

### Alerts you'll receive
| Trigger | Severity | Message |
|---|---|---|
| trial-expiry-notifier: some emails fail | ⚠️ warning | "3 email(s) failed to send" |
| razorpay-webhook: unhandled exception | 🔴 error | "Unhandled error on subscription.charged" |

### What NOT to alert (too noisy)
- enroll-subscribe failures (merchant sees error in the form immediately)
- merchant-reset-password failures (merchant sees error immediately)
- reactivate-billing failures (merchant sees error immediately)

### Files changed
- New EF: `alert-error` v1
- Updated EF: `trial-expiry-notifier` v3 (one fire-and-forget call at end)
- Updated EF: `razorpay-webhook` v28 (one fire-and-forget call in catch)
- NO frontend changes

---

## 3 — Plan Upgrade Self-Service

### Why
Merchants on Starter who want Pro/Premium must contact support. This is a
manual bottleneck that doesn't scale. Self-service upgrade = revenue without
admin time.

### The Razorpay constraint
Razorpay subscriptions are immutable on `plan_id`. You cannot change plans
on an existing subscription. The only way to change plans is:
create new subscription → cancel old subscription.

### Architecture: "Next cycle upgrade" pattern
New subscription starts exactly when the old one ends. No gap, no overlap,
no double-charge. Merchant authorizes the new mandate at their convenience
(up to 7 days before the billing date). Old subscription runs its natural
course and the new one takes over automatically.

### State machine
```
active (Starter)
  → [merchant clicks Upgrade to Pro]
  → upgrade-plan EF creates new Pro sub (start_at = current_end + 1 day)
  → shops.pending_plan_upgrade = { new_plan, new_sub_id, old_sub_id, effective_date }
  → merchant completes new mandate (opens rzp.io/i/xxx)
  → subscription.authenticated webhook fires for new sub
  → handleAuthenticated detects source='upgrade' → marks mandate_done=true
  → [on billing date] subscription.charged fires for new sub
  → handleCharged detects pending_plan_upgrade.new_sub_id matches
  → cancels old subscription via Razorpay API
  → updates shop: plan, subscription_plan, razorpay_subscription_id
  → clears pending_plan_upgrade
  → sends plan_upgraded email
  → shop is now on Pro
```

### What to build

#### DB migration
```sql
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS pending_plan_upgrade JSONB;
-- Shape: { new_plan, new_sub_id, old_sub_id, effective_date, mandate_done }
```

#### New EF: `upgrade-plan` v1
- Auth: Merchant JWT (Bearer)
- Input: `{ new_plan: 'pro' | 'premium' }`
- Validations:
  - `new_plan` must be strictly higher tier than `shop.plan` (no sidestep, no downgrade)
  - `shop.status` must be `'active'`
  - `shop.subscription_status` must be `'active'`
  - No existing `pending_plan_upgrade` (one upgrade at a time)
- Steps:
  1. `GET /v1/subscriptions/{razorpay_subscription_id}` → read `current_end`
  2. `effective_date = current_end + 86400` (one day after current period ends)
  3. Create new Razorpay subscription:
     ```json
     { plan_id: NEW_PLAN_ID, total_count: 60, quantity: 1,
       start_at: effective_date,
       notes: { shop_id, slug, plan: new_plan, source: "upgrade", old_sub_id: current_sub_id } }
     ```
  4. `shops.pending_plan_upgrade = { new_plan, new_sub_id, old_sub_id, effective_date, mandate_done: false }`
  5. Return `{ mandate_url, effective_date }`

#### Updated EF: `razorpay-webhook` v29
In `handleAuthenticated`: detect upgrade, mark mandate done.
```typescript
// After resolving shopId, before the main status update:
const { data: shop } = await sb.from('shops')
  .select('pending_plan_upgrade, status, subscription_status')
  .eq('id', shopId).single();

if (shop?.pending_plan_upgrade?.new_sub_id === subId) {
  // This authentication is for the upgrade sub, not the active sub
  await sb.from('shops').update({
    pending_plan_upgrade: { ...shop.pending_plan_upgrade, mandate_done: true }
  }).eq('id', shopId);
  await sb.from('subscription_events').insert({
    shop_id: shopId, event_type: 'upgrade_mandate_done',
    razorpay_sub_id: subId, raw_payload: payload,
  });
  console.log(`[webhook] upgrade mandate done: shop=${shopId} new_sub=${subId}`);
  return; // Don't run normal activation — shop is already active on old plan
}
// ... normal handleAuthenticated logic continues
```

In `handleCharged`: detect if charge is for the upgrade sub.
```typescript
// After resolving shopId, check for pending upgrade
const { data: shopData } = await sb.from('shops')
  .select('pending_plan_upgrade, razorpay_subscription_id')
  .eq('id', shopId).single();

if (shopData?.pending_plan_upgrade?.new_sub_id === subId) {
  const upgrade = shopData.pending_plan_upgrade;
  // Cancel old subscription
  try {
    const auth = btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`);
    await fetch(`https://api.razorpay.com/v1/subscriptions/${upgrade.old_sub_id}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancel_at_cycle_end: 0 }),
    });
  } catch (e) { console.warn('[webhook] old sub cancel failed:', e); }
  // Update shop
  await sb.from('shops').update({
    plan: upgrade.new_plan,
    subscription_plan: upgrade.new_plan,
    razorpay_subscription_id: subId,
    pending_plan_upgrade: null,
  }).eq('id', shopId);
  await sb.from('subscription_events').insert({
    shop_id: shopId, event_type: 'plan_upgraded',
    razorpay_sub_id: subId,
    raw_payload: { old_plan: shopData.plan, new_plan: upgrade.new_plan },
  });
  // Send upgrade email
  const shop2 = await getShop(sb, shopId);
  if (shop2?.owner_email) {
    await sendEmail('plan_upgraded', shop2.owner_email, shop2.owner_name ?? shop2.shop_name, {
      owner_name: shop2.owner_name ?? shop2.shop_name, shop_name: shop2.shop_name,
      old_plan: shopData.plan, new_plan: upgrade.new_plan,
      effective_date: upgrade.effective_date, dashboard_url: DASHBOARD_URL,
    });
  }
  console.log(`[webhook] plan upgraded: shop=${shopId} ${shopData.plan} → ${upgrade.new_plan}`);
  // Now fall through to normal handleCharged to record the payment
}
// ... normal handleCharged logic (insert payment, send receipt, update next_charge_at)
```

#### Updated `merchant.html`
In `renderBillingCard()`, for `subscription_status === 'active'`:

**Case A — No pending upgrade:**
```
[Current Plan: Starter · ₹199/mo]
[⬆ Upgrade plan]  ← opens inline plan picker
```

**Case B — Upgrade pending:**
```
[Upgrade to Pro pending — effective 15 Jul]
[Complete mandate →]  ← links to mandate URL for new sub
[Cancel upgrade]  ← calls cancel-plan-upgrade EF
```

#### New EF: `cancel-plan-upgrade` v1
- Auth: Merchant JWT
- Cancels the new Razorpay subscription (the not-yet-started one)
- Clears `shops.pending_plan_upgrade`
- Returns `{ ok: true }`

#### Email template needed: `plan_upgraded`
- Subject: "Your shop is now on [Pro] — Primo Rewards"
- Body: old plan → new plan, new monthly amount, next charge date

### Downgrade (NOT building now)
Downgrade (e.g., Pro → Starter) follows the same "next cycle" pattern
but is less urgent. Add as a separate feature. Current answer to a merchant
who wants to downgrade: admin does it via SQL.

### Files changed
- DB migration: `pending_plan_upgrade JSONB` column on shops
- New EF: `upgrade-plan` v1
- New EF: `cancel-plan-upgrade` v1
- Updated EF: `razorpay-webhook` v29 (handleAuthenticated + handleCharged)
- Updated: `merchant.html` (billing card upgrade UI)
- Updated: `send-email` EF (add plan_upgraded template)
- GitHub push required: `merchant.html`

---

## Future — Upstash Redis Rate Limiting

### When to build
**Only when you consistently have 1000+ live paying merchants** and see
evidence of rate-limit bypass in your Supabase EF logs (i.e., the same IP
submitting more than 3 requests per hour across multiple cold-start instances).

### Why it's not urgent now
Supabase routes requests from the same geographic region to the same warm
instance in practice. At <1000 shops the multi-instance scenario is
theoretical. The current in-memory Map still stops naive brute-force attacks,
which is the real threat at current scale.

### When you build it
1. Create Upstash Redis account (free tier: 10,000 req/day, enough for 1000 shops)
2. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` Supabase secrets
3. Replace `ipStore = new Map()` pattern in these EFs:
   - `enroll-subscribe`
   - `reactivate-billing`
   - `merchant-reset-password`
4. 15 minutes per EF, ~1 hour total

### Drop-in replacement (5 lines)
```typescript
import { Redis } from 'https://esm.sh/@upstash/redis';
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

const key   = `rl:enroll:${ip}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 3600);
if (count > 3)  return json({ error: 'Too many requests' }, 429);
```
