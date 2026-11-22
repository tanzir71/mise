# M32 preparation after an explicit undo — in progress

An older queued Ready could previously reapply Ready after a second preparation request completed it and the owner explicitly undid that status. The original contents still matched, so replay treated the earlier gesture as current. A regression reproduced the problem through the production HTTP handler and PostgreSQL before the fix.

Unaccepted preparation taps now require review after a newer explicit status undo. The saved action, original member, occurrence time, content hash and acknowledgement parent remain unchanged. The current ticket must be reviewed before recording a fresh gesture. Existing accepted receipts remain historical proof and can still be recovered without changing the order again.

## Current acknowledgement and historical proof

Undoing Ready leaves its earlier Got it current. Undoing a status transition performed by Got it removes that acknowledgement's effect on the current ticket; the actual accepted receipt stays in history. A new Ready cannot reuse an undone Got it as its parent. After a fresh explicit Got it, Ready binds to that new acknowledgement instead.

The server checks actual undo event identities and order revisions. It does not infer acknowledgement from a matching status or use a device clock to decide whose intent wins. The original action fence, live device/PIN authorization, closure protection and final snapshot comparison remain in place. An undo between preparation and completion rejects the held write, and its exact retry also requires review. Unrelated contact or payment edits retain the existing preparation behavior.

The current acknowledgement reader and Ready admission share a private helper that checks whether an acknowledgement's own status transition was undone. Anonymous, authenticated and service roles cannot call that helper directly. Its callers retain the original scoped device/current-PIN checks. The browser likewise keeps historical accepted receipts without treating an older receipt as the current ticket's acknowledgement.

No action/receipt wire format, native database version, original cached source or recorded financial amount changes. These checks also provide the current acknowledgement signal needed by the remaining unacknowledged-alarm work; that alarm is not implemented by this fix.

## Verification and delivery

All 4,014 unit cases in 194 files, lint and strict types pass. All twenty focused kitchen browser cases also pass. The two new browser regressions exercise a real owner domain undo, SQL transaction, private live feed, native queue and production preparation HTTP handler. They verify both an undone Got it and an older offline Ready that remains available for explicit review and closure. Fresh gestures preserve their correct parent, and order prices/payments remain unchanged.

The changed kitchen pages have 25 visual comparisons at 360, 390, 768, 1024 and 1440 px, with no overflow or automated WCAG AA violations. Five captures show Got it undone while its actual historical receipt remains visible. The supplied Kitchen tablet (`65:1843`) and phone (`107:1222`) guide layout and controls; their exports do not contain the historical review panel, so pixel differences are informational. The report is local `qa/report.html`; the representative captures are `qa/screens/m32-kitchen-undone-phone-390.png`, `qa/screens/m32-kitchen-undone-tablet-1440.png` and `qa/screens/m32-kitchen-review-tablet-1440.png`.

The deployed migration is the 56th. All three retrieved SQL body hashes match the reviewed source. All twelve Edge Functions retain their existing versions/JWT settings; this fix needs no function redeployment or new server credential. All 76 application tables force RLS. Anonymous/PUBLIC table grants, public definers, public buckets and direct client kitchen RPC grants remain absent. All 38 managed role checks pass, including nine new undo checks; every synthetic Auth/shop row is rolled back. Advisors report no warnings or errors. Genuine phone-provider and physical-device acceptance are not claimed.

The credential guard also recognizes the reserved server-only alarm key and both VAPID keys before any is generated. All 38 guard tests pass, including prefixless private values staged after their working copy was sanitized. The server env template contains blank names only; no new key, scheduler, extension or push subscription has been created, and reviewed history exceptions are unchanged.

All 521 Pages-path browser cases pass in the complete current run (18.2 minutes), with no failed or skipped cases. The full root-path build and all 35 selected browser cases pass: 28 exercise the compiled app and seven use an intercepted native IndexedDB harness independently of the compiled base. The complete Pages-path build is restored. The [verification record](m32-kitchen-undo-verification.json) contains source hashes, closed check results and remaining gates. Normal commit/push guards stay enabled, with a full history/artifact scan required before pushing.

M32 remains unchecked and `kitchenScreen` stays disabled by default. Configurable unacknowledged alarms, authoritative Inbox tasks, desk Web Push and final acceptance still need completion. GitHub workflows and Pages publication remain stopped at the owner's request. Actual deployment and credential values remain private.
