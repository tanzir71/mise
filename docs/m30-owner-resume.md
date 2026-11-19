# M30 — Restore the original owner connection before first download

An accepted initial upload can outlive the phone sign-in that selected its owner.
The existing shop may then be locked before its first canonical download. The
flagged operator picker now offers **Review cloud access** for this original
upload, opening **Restore the original connection**. Relevant Sync failures offer
the same route. Existing canonical shops keep their separate scope-recovery flow.

The screen reuses the original installed Auth namespace and existing phone forms.
The original compressed snapshot, full image bytes, receipt and queued local
changes are verified first. The status endpoint must confirm the exact accepted
receipt. Fresh original-account and current-owner metadata then authorize
selection and sync activation. No new upload is started, and the shop's working
rows, fence, command identities and receipts are preserved. The ordinary sync
engine still requires its real promotion-visibility proof before first adoption.

An original-owner control record lives under `owner:active` in `scopeRecoveries`.
It is distinct from a scope bridge, canonical admission and new-device join.
Earlier operations are retained under namespaced saved keys. Local schema 21 and
its 35 stores are unchanged; portable schema 10 still allows only the same 21
domain tables. Tokens, Auth UUIDs, connection values and deployment details never
enter this record or a backup.

The screen stays mounted through selection and activation. An interrupted final
write resumes the same operation after reload, including when another authorized
tab already adopted the original upload. Stop, cancel and Back preserve the
original source and pause matching delivery. The complete current shop and original
upload copy stay downloadable. Missing or corrupt original bytes require review
instead of a replacement snapshot.

Live account checks now reach native operator selection and session activation.
A changed account during those writes rolls back the affected transaction.
Auth-change observers start outside the rejected writer's transaction, so its
expected rollback cannot strand the interface in a general device error. Their
existing identity-generation checks still refuse stale revocation notices.

## Verification and remaining gates

The native app scenarios cover a real 5,000-record local upload with 400 ms latency
and 50,000 bytes/second in both directions, followed by lost sign-in before first
download, one new OTP verification through the original account, complete backup,
queued cash and image delivery. The upload completed in 28.870 seconds in the full
browser suite; it remained one promotion, with only status requests during restore.
The tests also cover a different account, an account change at native operator
selection, a lost ready write and resumption after reload.

The local PostgreSQL, HTTP, IndexedDB and app controls are exercised directly.
Auth verification, Realtime and object Storage use explicit synthetic adapters.
These results do not commission real SMS or prove genuine hosted phone OTP.
The feature remains behind default-off `cloudSync`; M30/M31 stay unchecked.
Remaining financial/manual reviews, staff/agent scopes and genuine hosted
acceptance still require work. This increment changes no hosted configuration.
Workflows and Pages publication remain stopped by the owner.

The [local verification record](m30-owner-resume-local.json) records passing lint,
typechecking with zero diagnostics, 2,452 unit tests across 134 files, all 440
Pages-path browser tests and 20 root-path sync/recovery browser tests. Both
`/` and `/mise/` production builds pass. All seven derived Edge Function bundles
are byte-identical to the deployed baseline; this increment needs no hosted
deployment.

The full local visual report, `qa/report.html`, contains 222 comparisons with no
horizontal overflow. The five owner-recovery views use the supplied M27 and
Desktop 14 settings references; M30 names no dedicated recovery frame, so pixel
differences are informational. The changed screen has no serious or critical axe
violations at 360, 390, 768, 1024 and 1440 px. All 270 supplied exports are present.
Three key captures are committed:

- [Phone, 360 px](screenshots/m30-owner-resume-360.png)
- [Tablet, 768 px](screenshots/m30-owner-resume-768.png)
- [Desktop, 1440 px](screenshots/m30-owner-resume-1440.png)

The [privacy audit](security-audit.json) covers source, staged files, fetched
reachable history and built output using private in-memory comparisons. No CI
artifact or new Pages deployment is claimed while workflows remain stopped.
