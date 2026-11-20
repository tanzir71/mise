# Saved order review

With cloud sync explicitly enabled, Settings → Sync shows **Review saved order
action** when an original order action needs review. **Check current values**
first inspects the actual server outcome. If already recorded, the genuine
receipt acknowledges that exact action; otherwise the interface compares the
original source with current order, customer, currency, payment and selected
khata values.

The proposed payment/refund records, projected khata balance and remaining refund
come from the same domain replay as the guarded SQL transaction. Credit-account
currency is labelled independently of an older order's currency. A changed
monetary currency prevents replacement and retains withdrawal/manual correction.
Cash given and change remain visible for a fresh physical cash check.

**Apply reviewed action** and **Withdraw saved action** save the explicit choice
before HTTP. A fresh check either discovers a genuine completed outcome, requires
another choice when displayed values changed, or uses its ephemeral review token
to complete that same decision. No decision is sent automatically on mount.
Withdrawal leaves current shop money unchanged. Existing undo expiry and credit
consent still apply.

After a lost reply, the original action and last chosen values survive offline
reload. **Check saved outcome** is read-only with respect to money. Deliberate
retry first checks the actual outcome, avoiding duplicate payments. A genuine
receipt acknowledges only the selected original command, then automatic sync
can deliver later cash and apply canonical proof. Stop retains an unconfirmed
decision; it does not claim to cancel an already committed server transaction.

Internal schema 23 adds `orderReviews`, for 37 native stores. Portable backup
schema 10 and its explicit 21-table allowlist remain unchanged. The journal
contains original source packets, display values, choice history and actual
receipts. It contains no review token, Auth UUID/session, API key or deployment
configuration. Runtime original-account checks surround HTTP and the native
writer. Locked before/after checks verify the original connection, source,
generation and saved review; a changed account, connection or source rolls back.

The UI uses existing Settings and order primitives, 44px controls, ink actions,
monochrome comparison cards and escaped literal source text. M31 provides no
dedicated review frame. Visual comparisons reuse M27 More and Desktop 14 Business
data tokens; pixel differences are informational. Review captures cover 360,
390, 768, 1024 and 1440px, plus unconfirmed phone/desktop states.

Local native-browser verification follows actual buttons → production client →
HTTP handlers → SQL → typed receipt → native acknowledgement → canonical sync.
Two devices change a price, retain a later cash action, lose the real completion
reply and reconnect after offline reload. Both apply and withdrawal preserve the
original commands, source changes and images without duplicate money. Auth,
Realtime and object Storage in this harness are explicitly synthetic.

The full browser run passed 447 cases; its sole failure expected the previous
schema/store count. The corrected native upgrade fixture now excludes the new
store from schema 14 and verifies that it starts empty after upgrade. All seven
coverage cases passed on rerun. Production assets were unchanged by that fixture
correction.

The final sync-header label correction was rebuilt at both base paths and
checked through native sync/review/coverage cases, including whole-page serious
and critical accessibility checks. Proposed financial records decode transport
JSON separately from SQL-row JSON, preserving literal wallet names without extra
quotes; real SQL and quote/NUL/Unicode regressions cover this distinction. Fixed
app chrome is hidden only while capturing the review section; accessibility
checks run on the actual page before screenshot styles.

Verification counts and current source deployment are recorded in
[the local evidence](m31-order-review-interface-local.json). The visual report is
clone-local at `qa/report.html`; key captures are
`qa/screens/m31-order-review-phone-review-390.png`,
`qa/screens/m31-order-review-desktop-review-1440.png` and
`qa/screens/m31-order-unconfirmed-phone-review-390.png`.

M30/M31 remain unchecked and cloud sync defaults off. [Normal order currency
admission](m31-order-currency.md) now checks the original saved unit. Other
financial families, physical-device and genuine
hosted phone verification remain open. All GitHub workflows and Pages publication
remain held, so there is no new CI artifact or Pages deployment claim. Current
source and build output exclude private Supabase values; the unchanged historical
nonsecret identifiers remain disclosed in the privacy audit.
