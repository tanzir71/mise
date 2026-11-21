# Open questions

- Resolved M30 pairing scope: the supplied setup frame uses a six-digit code, which is too short to act as a device credential. Use it only to select a pending request. The screen generates its own secret; a live owner/assigned manager compares a matching verification on both devices before approval. Keep runtime credentials outside shop backups, and require a blank browser/profile for a staff screen so existing owner records or sign-ins cannot leak into it. This is a product pairing action, not a delivery sign-off request. Native storage and UI are implemented behind default-off device access; full M30 acceptance remains open.

- Resolved M30 upload storage: initial upload and local writes need one native IndexedDB transaction boundary. Local schema 11 therefore adds two internal stores while portable backups remain schema 10. Typed financial intents can be delivered; all other local writes remain retained recovery evidence until their adapters and canonical reconciliation are ready. This does not enable the sync interface or complete M30.

- Resolved by the refinement handover: all indexed Figma exports are supplied. Phase R replaces the previous HTML/CSS marketing previews with those images and compares the new hero with the exported references.
- Owner configuration: set PUBLIC_WHATSAPP_URL / PUBLIC_DEMO_URL before accepting contact or demo requests. No number or booking service is invented.

- Resolved M23 editable-preview resumption: keep explicit source-template identity alongside the owner-edited message before enabling the shared interface. Reopening an unchanged template should restore the edit and its progress; changed source details or destination should require a fresh reviewed attempt. Implemented compatible version-2 template snapshots and a resume lookup, retaining version-1 history. This is an implementation decision, not an owner sign-off request.

- Resolved M23/M63 overlap: M23 explicitly requires win-back hand-off now, so add a manually reviewed message for one existing customer. Leave identity merging, segmentation and targeting in M63. No backend or automated sending is introduced.

- Resolved for M30 financial admission: preserve the device occurrence time, but enforce the existing undo deadline using the live server clock. Keep expired/rejected offline intents for explicit review when M31 is implemented. New-customer/account related-ID reconciliation also remains an explicit prerequisite to enabling the outbox. No owner sign-off is requested.

- Resolved M30 customer/account identity: strict device-generated companion-ID plans now retain the exact account/opening/audit IDs from the local mutation. Conflicting current-account creation returns retained-intent review. M31 still needs ordered delivery and conflict resolution; the outbox remains unavailable.

- Resolved M30 operator-picker reference: M30 names no dedicated frame. Reuse the existing onboarding/card primitives, with M38's outlet hierarchy as a visual reference, and verify all five required widths. Differences are informational; do not claim an exact match or request owner sign-off.

- Resolved M31 original order currency: normal delivery now derives the saved unit from the immutable original order source and asserts it separately from the unchanged command/hash. Actual completed receipts replay first; mismatched new writes and profile races stay retained. Non-order financial currency/conflict boundaries remain implementation work before enabling cloud sync.

- Resolved M31 ordinary money currency: counter and khata actions now derive their original unit from immutable saved sale/entry images, retaining companion and undo identities. Admission checks every retry after actual outcome lookup; historical account currency remains valid after profile changes. Explicit money review/resolution, stock/purchase/closing boundaries and full hosted acceptance remain open before enabling cloud sync.

- Resolved M31 pending canonical currency: a real native regression projected a saved BDT sale in USD during download. Both canonical and outlet-recovery plans now bind pending projections to the immutable original queue currency, after real coverage checks and before any domain/cursor write. Historical covered rows and valid original-account payments remain usable. Financial review/resolution and remaining M31 acceptance stay open.

- Resolved M30 lost shared-screen PIN replies: a server-created session secret cannot be recovered after its response is lost. Persist the screen's attempt ID before HTTP, keep PIN digits transient, and use an idempotent device-authenticated reset to retire both that attempt and the screen's sessions before an explicit retry. This also handles delayed begin requests, failed native writes and interrupted sign-out without affecting another screen or guessing counters. Owner records stay untouched; original provider, genuine signed-owner HTTP and full M30 delivery acceptance remain open.
