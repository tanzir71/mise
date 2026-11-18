# Open questions

- Resolved M30 upload storage: initial upload and local writes need one native IndexedDB transaction boundary. Local schema 11 therefore adds two internal stores while portable backups remain schema 10. Typed financial intents can be delivered; all other local writes remain retained recovery evidence until their adapters and canonical reconciliation are ready. This does not enable the sync interface or complete M30.

- Resolved by the refinement handover: all indexed Figma exports are supplied. Phase R replaces the previous HTML/CSS marketing previews with those images and compares the new hero with the exported references.
- Owner configuration: set PUBLIC_WHATSAPP_URL / PUBLIC_DEMO_URL before accepting contact or demo requests. No number or booking service is invented.

- Resolved M23 editable-preview resumption: keep explicit source-template identity alongside the owner-edited message before enabling the shared interface. Reopening an unchanged template should restore the edit and its progress; changed source details or destination should require a fresh reviewed attempt. Implemented compatible version-2 template snapshots and a resume lookup, retaining version-1 history. This is an implementation decision, not an owner sign-off request.

- Resolved M23/M63 overlap: M23 explicitly requires win-back hand-off now, so add a manually reviewed message for one existing customer. Leave identity merging, segmentation and targeting in M63. No backend or automated sending is introduced.

- Resolved for M30 financial admission: preserve the device occurrence time, but enforce the existing undo deadline using the live server clock. Keep expired/rejected offline intents for explicit review when M31 is implemented. New-customer/account related-ID reconciliation also remains an explicit prerequisite to enabling the outbox. No owner sign-off is requested.

- Resolved M30 customer/account identity: strict device-generated companion-ID plans now retain the exact account/opening/audit IDs from the local mutation. Conflicting current-account creation returns retained-intent review. M31 still needs ordered delivery and conflict resolution; the outbox remains unavailable.

- Resolved M30 operator-picker reference: M30 names no dedicated frame. Reuse the existing onboarding/card primitives, with M38's outlet hierarchy as a visual reference, and verify all five required widths. Differences are informational; do not claim an exact match or request owner sign-off.
