# M13 · Customer and credit data foundation

The data foundation adds customers, credit accounts and immutable ledger entries to IndexedDB version 3. Existing profiles, catalogue, cash sales and audit events survive the upgrade. Credit is not enabled in the UI yet; M13 remains unchecked and `khata` defaults off.

All writes use pure commands and atomic Dexie transactions. Credit sales append a sale and charge together, with both audit events. Balances are the exact sum of entries in integer minor units. Over-limit consent is tied to the balance and limit the owner reviewed and is rechecked at commit. Payments cannot exceed the amount due. Reversals retain the originals and are allowed once within ten minutes; a credit sale reversal also reverses its charge.

Ledger sequence numbers preserve causal order when timestamps tie or the device clock moves back. FIFO ageing ignores reversed pairs, so reversing a payment restores the original unpaid age. The Over 30 days amount counts older unpaid portions, not every newer purchase by an older debtor. Totals remain separate by currency. Paid-up customers can be archived and restored without losing history; customers with debt cannot be removed.

Reminder helpers provide default Bangla/English text, owner-editable templates, optional explicit payment instructions and WhatsApp/call links. They do not open apps or send messages. Completed receipt, reminder and call actions are separately attributable and do not change balances. Monthly dates clamp to month end, and week boundaries follow the market pack. The next increment connects these commands to the three supplied khata frames and the counter's Baki action.

Validation includes 164 unit tests, with 500 generated transaction sequences compared against an independent balance model, same-timestamp and clock-correction cases, concurrent limits/payments, rollback and migration tests. The unchanged M12 app also runs through the existing browser and visual suites in CI.
