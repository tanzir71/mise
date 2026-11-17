# Open questions

- Resolved by the refinement handover: all indexed Figma exports are supplied. Phase R replaces the previous HTML/CSS marketing previews with those images and compares the new hero with the exported references.
- Owner configuration: set PUBLIC_WHATSAPP_URL / PUBLIC_DEMO_URL before accepting contact or demo requests. No number or booking service is invented.

- Resolved M23 editable-preview resumption: keep explicit source-template identity alongside the owner-edited message before enabling the shared interface. Reopening an unchanged template should restore the edit and its progress; changed source details or destination should require a fresh reviewed attempt. Implemented compatible version-2 template snapshots and a resume lookup, retaining version-1 history. This is an implementation decision, not an owner sign-off request.

- Resolved M23/M63 overlap: M23 explicitly requires win-back hand-off now, so add a manually reviewed message for one existing customer. Leave identity merging, segmentation and targeting in M63. No backend or automated sending is introduced.

- Resolved for M30 financial admission: preserve the device occurrence time, but enforce the existing undo deadline using the live server clock. Keep expired/rejected offline intents for explicit review when M31 is implemented. New-customer/account related-ID reconciliation also remains an explicit prerequisite to enabling the outbox. No owner sign-off is requested.
