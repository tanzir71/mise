# Staff attendance and private shift links

Status: M34 implementation in progress. `staffTeam` remains off by default. GitHub workflows, Pages publication and the public service remain held. The complete milestone is unchecked; shared order-phone attendance and task permission enforcement still need their actual runtime paths. M35 and subsequent milestones remain required.

## Working preview

An installation’s signed-in owner or assigned manager can add, edit and remove members in Team. A contact phone never creates or links an Auth account. Removal keeps recorded history. Managers cannot promote themselves or expand someone’s wider outlet access.

The board reads the actual outlet roster and latest attendance every 1.5 seconds while visible. Staff who are in appear as compact rows following M18. Missing staff have contact actions, Copy and Mark done. Marking contact done does not check anyone in. “Told you in person?” opens a working member selector and attendance sheet. A manual check-in records the manager’s actual identity; its time, method and audit follow the same domain rules as link attendance.

Save a member with their own staff link enabled, reopen the editor and create a 30-day link. Copy it privately to that member. The secret is generated and retained in that owner browser before HTTP; only its hash is sent and stored by the backend. Original creation can be recovered after a lost response without producing another link. Other owner devices can revoke that link and create their own replacement.

The `/app/me/<token>` page works in English and Bangla, without phone sign-in or an owner database. It shows only that member’s configured shift and recorded activity at that outlet. “I’m here”, break and leaving preserve their complete original intents before HTTP. Check, retry and closure use that same original after reload. Offline closure is saved before a request and prevents a later delayed submit from recording attendance. A stale arrival cannot overwrite a newer departure.

Revocation, expiry, removal, lost assignment or disabled link method deny fresh reads and taps. A genuine older receipt can still acknowledge its exact original; it grants no fresh view. Full storage prevents new writes while retaining a readable manual message. Copy fallbacks remain selectable inside the actual dialog or staff page.

## Installation configuration

Follow [Configure services](configure-services.md#staff-shift-links-opt-in-preview). Every installation supplies its own hosting, backend, owner phone accounts and private service environment. No personal maintainer account, credential or verification number is required. Templates start empty, and `MISE_STAFF_LINKS_ENABLED` defaults to false independently of public ordering. Secrets stay server-side; phone contact numbers and public receiving numbers are explicitly configured by the installation.

Staff links have separate global/per-capability request budgets and a closed HTTP projection. They cannot read order, money or other staff records. There are no provider calls or financial effects. Shared-screen permissions are not expanded by saved task preferences. Unconfigured wages, overtime, group-capture health and performance samples from the reference frames are omitted.

## Verification checkpoint

- Lint and type checking pass, including 192 Astro files without diagnostics.
- All 4,743 unit cases across 240 files pass, including 85 focused staff domain, SQL, HTTP and original-session cases. Original 1,000-item, 5,004-history and 5,000-upload workloads and their deadlines are unchanged.
- All 635 production Pages browser cases pass, including 17 staff cases for actual CRUD, manual/link attendance, board updates, lost replies, offline closure, revocation, full storage and clipboard recovery.
- All 78 selected root-path browser cases pass. The manual proposal now preserves station, WhatsApp choice, methods and requested preferences; its native dialog copy is verified along with staff, shell, khata, customer links and checkout. A final 17-case Pages follow-up also passes for this text-only fix.
- Twenty final visual comparisons cover Team, Members, member editing and My shift at 360, 390, 768, 1024 and 1440 px. Their accessibility checks have no violations or overflow. Native sheets start at their actual top after image decoding. Three inspected captures show [Team](images/staff-team-390.png), [the member editor](images/staff-member-390.png) and [My shift in Bangla](images/staff-shift-390.png).
- Forty-three managed role checks pass in a rolled-back transaction, creating two actual check-ins with zero financial writes and zero provider requests. Test Auth users and all fixture records are absent afterward.
- The three applied staff migrations exactly match reviewed source. All 106 application tables force RLS; all 435 earlier function definitions and 17 earlier Edge versions remain unchanged. The staff member foreign key has its own covering index. Staff tables have no direct grants; the security advisor reports only expected informational notices for private deny-all tables. The scheduler remains off and active Cron jobs remain zero.

Both `/mise/` and `/` production builds pass, with the final output restored to `/mise/`. The [machine-readable verification](staff-attendance-verification.json) records checks, source hashes, applied migrations and screenshot hashes. No CI run, Pages deployment, enabled feature or full M34 completion is claimed by this checkpoint.

## References

The six supplied milestone references are M18 `103:644`, M19 `103:793`, M07 `59:59`, M05 `58:118`, desktop Team `60:1558` and desktop Members `72:2105`. All 270 exports are present. The current [visual configuration](../qa/configs/m34-staff.json) compares the implemented owner and staff views; the enrolled order-phone reference remains for its unfinished path.

Generate local comparison reports with `pnpm qa:visual qa/configs/m34-staff.json` after building. The owner’s workflow hold prevents CI artifact upload and public deployment; the report remains a local artifact and the three reviewed captures are retained above.
