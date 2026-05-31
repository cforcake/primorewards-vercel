# Primo Rewards — Next Build Session

## Already Built (this session)
1. ✅ Duplicate enrollment prevention (enroll-subscribe v5)
2. ✅ Forgot password — merchant-reset-password EF + login UI
3. ✅ Verify payment — sync-billing-status EF + billing tab button

## Build Next Session (in order)

### 4. Rate limit `reactivate-billing` EF
**Why:** Currently anyone who knows a merchant's slug can hammer it, creating orphaned Razorpay subscriptions.
**How:** Add same ipStore pattern as enroll-subscribe — 3 attempts per IP per hour.
**File:** reactivate-billing EF (single update, ~15 lines added at top of handler)

### 5. Admin: Manual subscription sync button
**Why:** If webhook is missed and merchant calls support, admin has no self-service fix — must use SQL editor.
**How:** 
- Add a "Sync from Razorpay" action to admin-action EF
- Add a button in primo-admin-v2.html on the shop detail row
- Calls GET /v1/subscriptions/{id} → applies same logic as sync-billing-status EF
**Files:** admin-action EF (new action 'sync_subscription') + primo-admin-v2.html

### 6. Clean up existing C for Cake duplicates
**Why:** C for Cake currently has ≥2 shops rows in DB.
**How:** Admin panel → find duplicate email entries → keep most recent trial_pending one → set others to suspended → cancel orphaned Razorpay subs
**Action:** Via admin panel or SQL one-time cleanup

## Known gotchas for next session
- cron_nonces table uses RLS (no public read) — service role only
- pg_cron job 2 reads nonce via SQL (no alter database needed)
- merchant-reset-password EF: always returns success regardless of email found (security)
- sync-billing-status maps Razorpay 'authenticated' + 'active' → shop active
- enroll-subscribe dedup: email-only check (not phone) — phone dedup is a future improvement
