# M32 live kitchen timing — in progress

The managed scheduler now completes the actual Cron → Net → deployed coordinator → alarm path. Sixteen isolated live checks pass. With the default two-minute warning, the alarm is raised 815 ms after its original due time. Resuming after a rolled-back dispatch raises the original overdue alarm in 2,495 ms. These are measured results from this commissioning run, rather than a latency guarantee.

The test uses a fictional shop, original orders and a synthetic device session, with no Auth accounts, push subscriptions or provider recipients. The production ticket reader supplies the ticket used by the production Got it handler. Acknowledgement closes the alarm, leaves financial values unchanged and returns the source to idle. Disable removes the owned job while retaining original work; idle waiting sends no HTTP request. A native transaction rollback removes its Cron job, Net request and grant without sending HTTP, and later enable recovers the original order.

Cleanup removes only that fixture and its original grants. The final managed check confirms no businesses, Auth users, subscriptions, deliveries, grants, alarm tasks, watches, queued requests or Cron jobs. Cron and Net remain installed for later explicit use; the kitchen scheduler is disabled. No real phone-owner sign-in, provider acceptance, browser notification display or physical-device acceptance is claimed.

## Vault binding correction

Commissioning first exposed a configuration failure before a job or request was created. The real Vault view includes its own `key_id` column, which collided with the private function's parameter. The migration now qualifies both original secret references with the function name, as supported by [PostgreSQL parameter qualification](https://www.postgresql.org/docs/17/plpgsql-implementation.html#PLPGSQL-VAR-SUBST). It preserves the function signature, closed search path, validation and denied client access. Previously applied migrations are unchanged.

The local Vault adapter now includes the real conflicting column. The full SQL-to-encrypted-dispatch case deliberately assigns a different encryption-key identity, so lookups must use the original input references. The improved fixture reproduced the original SQL ambiguity before the correction; all 45 dedicated SQL, authentication and packaged-runtime cases pass afterward.

The managed database has 62 migrations and 87 application tables across the public and private schemas, all with forced row-level security. No public function is a security definer, and API roles cannot execute the private scheduler controls. Security and performance advisors report no warnings or errors. Actual credentials, organization/project details and private Vault references remain outside tracked files and generated output.

## Delivery evidence and remaining work

The [timing verification record](m32-kitchen-timing-verification.json) records the local regression results, live measurements, source hashes and final inactive state. The [preceding scheduler checkpoint](m32-kitchen-scheduler.md) retains its historical deployment and boundary-test evidence.

M32 remains open. Current-ticket startup paging, useful subscription-reference indexes and genuine phone/provider/browser/device acceptance still need work. Kitchen feature flags default off. GitHub workflows and Pages publication remain stopped at the owner's request; this increment makes no CI or publication claim. Full M30/M31 acceptance and the remaining handover milestones are also unfinished.
