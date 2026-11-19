# Private deployment details in Git history

A deployment URL introduced in one commit and removed in the next could previously
pass the push guard. An old credential filename could also escape detection when
another file reused its empty blob. Synthetic Git fixtures reproduced both gaps.

The guard now checks every reachable blob, commit, annotated tag and raw tree.
Raw trees retain every filename, including aliases of identical content. It also
checks branch and tag names, including an unborn current branch. New deployment
identifiers in history fail the scan after their current files have been cleaned.

The [reviewed policy](../scripts/legacy-deployment-findings.json) contains 21 opaque
SHA-256 fingerprints for the 22 previously documented historical nonsecret
findings. Each fingerprint binds the complete object bytes, object type and matched
rule. A later message or changed object receives a different fingerprint.
Credentials always fail the scan, including credentials whose fingerprints appear
in a policy. The policy contains no project identifier, organization identifier
or credential value. Existing published history stays intact.

Keep the reviewed fingerprints fixed. Remove new private identifiers from the
candidate history instead of adding exceptions. A missing or malformed policy
blocks the operation. A shallow checkout cannot establish complete history and
must fetch it before the full audit:

```sh
git rev-parse --is-shallow-repository
# If this reports true:
git fetch --unshallow --tags
pnpm check:secrets --history --artifacts
```

Private comparison values remain in ignored configuration outside the repository.
The existing UTF-16, ZIP, staged-file and exact-value checks still apply. Findings
contain rule names, redacted locations and opaque historical fingerprints.

The 35 focused guard tests pass. They include a real permitted push containing
only a reviewed synthetic legacy object, followed by a rejected push containing
a later identifier; the remote remains at its original commit. Other cases cover
commit/tag messages, reused empty files, private reference names, incomplete
history, unavailable policy, and attempted credential exceptions. No hosted
Supabase setting or credential changes are required.

The [local verification record](security-history-local.json) records passing lint,
strict TypeScript and 131 Astro files without diagnostics, all 2,476 unit tests
across 135 files, and production builds at `/` and `/mise/`. The original 1,000-row
bulk limits and payloads remain unchanged. The final full suite passes with its
normal two-worker setting after the other checks finish.

The app component and related verification sources remain unchanged, but the app
bundles `CHANGELOG.md` into its What’s new page. The release-note update changes
asset hashes. Fresh verification therefore runs all 443 Pages browser cases and
all 247 visual comparisons against the generated output. There are no failed,
flaky or skipped browser cases and no horizontal overflow in the visual report.
GitHub workflows and Pages publication remain held.
