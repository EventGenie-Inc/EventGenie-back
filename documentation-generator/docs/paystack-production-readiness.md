# Paystack Payment Gateway – Production Readiness Considerations

The following are important technical considerations for auditing the existing Paystack payment integration in e-velope before production go-live.

These serve as guidelines for identifying potential vulnerabilities, weaknesses, missing safeguards, and areas that require improvement.

### 1. Idempotency and Duplicate Payment Prevention
- Unique transaction references.
- Prevention of duplicate payment initialization.
- Prevention of duplicate charges.
- Duplicate webhook event handling.
- Protection against concurrent payment requests.
- Prevention of duplicate order fulfilment.
- Safe handling of repeated payment verification requests.

### 2. Payment Verification
- Backend-side transaction verification with Paystack.
- Validation of transaction references.
- Verification of actual transaction status.
- Amount validation against the expected amount.
- Currency validation.
- Customer and transaction ownership validation.
- Prevention of frontend-manipulated payment confirmations.
- Prevention of fulfilment before successful payment verification.

### 3. Webhook Security and Reliability
- HMAC-SHA512 signature verification.
- Secure webhook endpoint over HTTPS.
- Rejection of invalid webhook signatures.
- Duplicate webhook event handling.
- Webhook retry handling.
- Appropriate HTTP response codes.
- Asynchronous event processing where appropriate.
- Handling of delayed and out-of-order webhook events.
- Protection against webhook replay attacks.
- Reliable processing when database operations fail.

### 4. Payment State Management
- Consistent payment lifecycle.
- Appropriate transaction statuses (pending, successful, failed, abandoned, reversed, refunded).
- Valid state transitions.
- Prevention of successful payments being incorrectly downgraded.
- Handling of payments that remain pending.
- Synchronisation between payment records and associated business records.
- Accurate frontend representation of payment status.

### 5. Amount and Currency Integrity
- Backend-controlled payment calculations.
- Correct conversion to the smallest currency denomination.
- Avoidance of floating-point precision errors.
- Validation of transaction amounts.
- Validation of supported currencies, particularly ZAR.
- Prevention of zero, negative, or manipulated amounts.
- Consistency between initialized, verified, and recorded payment amounts.

### 6. Security and Credential Management
- Protection of Paystack secret keys.
- Secure environment variable management.
- Separation of test and live credentials.
- No credentials committed to source control.
- Appropriate authentication and authorization on payment endpoints.
- Protection against IDOR and transaction reference manipulation.
- No exposure of sensitive payment information through API responses.
- Secure logging practices.
- Appropriate access restrictions for payment-related operations.

### 7. Database Integrity and Consistency
- Unique constraints on transaction references.
- Correct relationships between payments, customers, and relevant business entities.
- Atomic database operations where necessary.
- Appropriate transaction boundaries.
- Prevention of duplicate database records.
- Handling of concurrent webhook requests.
- Protection against race conditions.
- Consistency between payment status and associated business operations.
- Reliable recovery from database failures.

### 8. Network Reliability and Error Handling
- Paystack API timeouts.
- Network interruptions.
- HTTP 4xx and 5xx responses.
- Rate limiting (HTTP 429).
- Temporary Paystack unavailability.
- Failed transaction verification requests.
- Appropriate retry mechanisms.
- Prevention of duplicate charges during retries.
- Handling of uncertain payment outcomes.

Important consideration: A network timeout does not necessarily mean that a payment failed. The transaction may have been successfully processed by Paystack even when e-velope did not receive the response.

### 9. Refunds, Reversals and Disputes
- Refund processing.
- Refund verification.
- Partial refund considerations.
- Transaction reversals.
- Chargebacks and disputes.
- Accurate refund status tracking.
- Preservation of original transaction records.
- Distinction between failed payments and refunded payments.

### 10. Financial Reconciliation and Auditability
- Internal transaction references.
- Paystack transaction references.
- Accurate payment amounts and currencies.
- Transaction timestamps.
- Payment status history.
- Refund records.
- Settlement reconciliation.
- Traceability of payment-related changes.
- Ability to identify discrepancies between e-velope records and Paystack records.

### 11. Frontend Payment Experience
- Prevention of repeated payment submissions.
- Accurate payment success and failure messages.
- Appropriate loading states.
- Safe handling of page refreshes.
- Handling of abandoned checkout sessions.
- Appropriate handling of pending transactions.
- No reliance on frontend redirects as proof of payment.
- Protection against exposing internal errors or sensitive information.

### 12. Testing and Edge Cases
- Successful payments.
- Failed payments.
- Abandoned payments.
- Duplicate payment requests.
- Duplicate webhook deliveries.
- Invalid webhook signatures.
- Invalid transaction references.
- Incorrect payment amounts.
- Incorrect currencies.
- Delayed webhook notifications.
- Customer closing the browser after successful payment.
- Concurrent payment requests.
- Concurrent webhook processing.
- Paystack API timeouts.
- Database failures.
- Unauthorized transaction access.
- Refund and reversal scenarios.

### 13. Production Environment and Configuration
- Correct production Paystack public key.
- Correct production secret key.
- Separation of test and production environments.
- Correct production webhook URL.
- HTTPS configuration.
- Secure environment configuration.
- Appropriate CORS settings.
- Production database configuration.
- Database migration readiness.
- Logging and monitoring.
- Error tracking and operational visibility.
- Removal of test-mode assumptions and development-only configurations.

### 14. Payment-Specific Business Logic
- Correct association between payments and e-velope's products or services.
- Prevention of users accessing paid functionality without successful payment.
- Prevention of duplicate fulfilment.
- Correct handling of unsuccessful or abandoned purchases.
- Consistency between payment completion and the corresponding business operation.
- Appropriate handling of users who complete payment but leave before returning to e-velope.
- Accurate payment history for customers.

### 15. e-velope and Paystack specifics
- South African bank accounts can't be verified by Paystack: an
  organiser's subaccount details need a confirmation step, since a
  wrong account sends ticket revenue to a stranger.
- The settlement account receiving e-velope's own money is correct.
- The name and logo on customers' bank statements read e-velope.
- Plans and subaccounts are separate per mode: the four plans are
  recreated in live mode with new codes, and subaccounts re-onboarded.
- Known gap: submit() returns a raw row including editToken to an
  unauthenticated caller.
- Decisions since the pilot: ticket commission 2%; Elevate's SMS limit
  (1,000 a month proposed); Paystack plan names read like
  "e-velope Elevate (Annual)"; the guest pays the commission and
  Paystack's fee (gross-up), while Paystack was told the organiser
  pays the fee, to be reconciled before ticket sales go live.

  
**Overall objective:** Ensure that the Paystack integration in e-velope is secure, reliable, idempotent, financially consistent, auditable, and sufficiently robust to handle real-world production payment scenarios.

---

## Scorecard after payments release 1 (2026-11-19)

Branch `feature/payments-release-1`. Release 1 covers **subscriptions,
Event Passes and SMS bundles** ("Release 1" column). **Tickets** are a later
release; their column shows where they stand today. COVERED means the code
does it **and** a named test proves it (tests in `tests/payments/` unless
another folder is named); PARTLY means something is still missing (said
in the evidence); a status in *italics* needs a person, not code.

Test files: **pass** `event-pass-payments.test.ts` · **sms**
`sms-bundle-payments.test.ts` · **sub** `subscription-payments.test.ts` ·
**hook** `webhook-and-reconciliation.test.ts` · **client**
`paystack-client.test.ts` · **money** `money-and-gross-up.test.ts`.

### 1. Idempotency and duplicate prevention
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Unique references | COVERED | PARTLY | Random references, `paymentRef @unique`. pass "the signed charge.success grants it". Tickets: a retry overwrites the reference (A2). |
| No duplicate initialisation | COVERED | PARTLY | One pending checkout reused (`pending-checkout.util.ts`). pass "the same tier again reuses the checkout", sms "the same count again reuses", sub "the same plan again reuses the checkout". |
| No duplicate charges | COVERED | PARTLY | Reuse plus duplicate-subscription detection. sub "a subscription.create the tenant didn't ask for". |
| Duplicate webhooks | COVERED | COVERED | Body-hash dedupe key, idempotent handlers. pass "the same delivery twice is a duplicate". |
| Concurrent payment requests | COVERED | COVERED | Advisory lock per event; conditional claim per tenant; tickets' atomic hold. pass "two purchases at the same moment start one checkout", sub "two at once start one checkout". |
| Duplicate fulfilment | COVERED | COVERED | Row lock on confirm. hook "concurrent deliveries of one success confirm it once". |
| Repeated verify requests | COVERED | PARTLY | pass "reconcile confirms by asking Paystack; the webhook arriving later changes nothing". Tickets' confirm route isn't rate limited. |

### 2. Payment verification
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Backend verification | COVERED | COVERED | Webhook or verify only. sub "POST /verify activates the subscription". |
| Reference validation | COVERED | COVERED | By our own reference. pass "the signed charge.success grants it". |
| Actual status | COVERED | COVERED | Only `success` confirms. pass "reconcile on an unpaid checkout leaves it pending". |
| Amount vs expected | COVERED | MISSING | `checkAmount`. pass "a success for the wrong amount grants nothing", sub "a renewal charge for the wrong amount". |
| Currency | COVERED | MISSING | pass "a success in the wrong currency grants nothing". |
| Ownership | COVERED | COVERED | pass "another tenant can't reconcile this purchase"; `tenant-scope/event-pass-reconcile-scope.test.ts`. |
| No frontend-faked confirmation | COVERED | COVERED | pass "the signed charge.success grants it" (nothing before the webhook). |
| No fulfilment before verification | COVERED | MISSING | Tickets: invite ACCEPTED and checked in unpaid (B1). |

### 3. Webhooks
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| HMAC-SHA512 | COVERED | COVERED | pass "an invalid signature is 401 and changes nothing". |
| HTTPS | *PARTLY* | *PARTLY* | Render's TLS; the live webhook URL is set in Paystack's dashboard (cutover). |
| Reject invalid signature | COVERED | COVERED | Same test. |
| Duplicate handling | COVERED | COVERED | pass "the same delivery twice is a duplicate"; hook "two different deliveries with neither an id nor a reference are both handled". |
| Retry handling | COVERED | COVERED | hook "a database failure while handling: 500, … Paystack's retry is processed". |
| Response codes | COVERED | COVERED | 401 / 200 / 500, same tests. |
| Asynchronous processing | NOT APPLICABLE | NOT APPLICABLE | Small transactional work; slow work after commit. |
| Delayed / out-of-order | COVERED | PARTLY | sub "a late disable for the old subscription after resubscribing", "an upgrade lands on the new plan … (both orders)", "the other order (subscription.create first)". |
| Replay | COVERED | COVERED | Signature plus dedupe key. |
| Database failure | COVERED | COVERED | hook "a database failure while handling". |

### 4. Payment state
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Consistent lifecycle | COVERED | PARTLY | PENDING/PAID/FAILED/REFUNDED/REVERSED/UNDER_REVIEW. |
| Statuses incl. reversed/refunded | COVERED | MISSING | pass "a full refund removes the pass", "opened … lost: taken back (REVERSED)". Tickets have no refunded status. |
| Valid transitions | COVERED | COVERED | pass "a failed attempt then a success on the same checkout is granted". |
| No downgrade of success | COVERED | COVERED | pass "a charge.failed after the purchase is paid never downgrades it", "a cheaper purchase paid after a dearer one". |
| Stuck pending | COVERED | PARTLY | Hourly stale sweep. pass "a day-old checkout Paystack calls abandoned becomes FAILED", sub "a day-old unpaid attempt is cleared". Tickets: lazy sweep per ticket. |
| Payment ↔ business sync | COVERED | PARTLY | Same transaction; refunds applied. |
| Frontend status | *PARTLY* | PARTLY | Backend gives statuses and `pendingChange`; the frontend's "payment accepted" wording is the frontend's release. |

### 5. Amount and currency
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Backend calculation | COVERED | COVERED | Server prices only. money "a R100 ticket at 2%". |
| Smallest unit | COVERED | COVERED | money "converts without float error, both ways". |
| No float errors | COVERED | COVERED | Same test. |
| Validate amounts | COVERED | MISSING | §2. |
| ZAR | COVERED | COVERED | money "checkAmount …"; ZAR hard-coded at initialise. |
| Zero/negative/manipulated | COVERED | PARTLY | pass "an unknown passTier is 422", sms "a bad count is 422". Tickets: a R0 ticket charges ~R1.19. |
| Init = verify = recorded | COVERED | PARTLY | Amount check; ledger amounts from the stored purchase. |

### 6. Security and credentials
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Secret key protection | COVERED | COVERED | Environment only; client "the message never carries the key". |
| Environment management | *PARTLY* | *PARTLY* | Render (cutover). |
| Test/live separation | COVERED | COVERED | `assertPaystackKeyMode`; client "production needs live keys; every other environment needs test keys". |
| No credentials in git | COVERED | COVERED | Checked by `git log -S` in the audit (no test). |
| Endpoint authorisation | COVERED | COVERED | `feature-flags/payments-off-routes.test.ts`; hook "the super admin sees …; a tenant admin gets the global 404". |
| IDOR | COVERED | COVERED | pass "another tenant can't reconcile". |
| No sensitive data in responses | COVERED | PARTLY | client "users never see Paystack's own text", pass "a timeout: a neutral 503 … no raw text". Tickets: guest checkout errors still pass Paystack's text. |
| Secure logging | PARTLY | PARTLY | Raw Paystack bodies in logs (no card data); Sentry scrubbed (`tests/monitoring`). |
| Access restrictions | COVERED | COVERED | As above. |

### 7. Database integrity
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Unique constraints | COVERED | COVERED | `paymentRef`, `dedupeKey`, `runDate` unique. |
| Relationships | COVERED | COVERED | Ledger `relatedId` is the purchase id on every row (pass "the signed charge.success grants it" checks it). |
| Atomic operations | COVERED | COVERED | One transaction per confirmation, INITIATED written with the purchase row. |
| Transaction boundaries | COVERED | COVERED | No Paystack call inside a transaction (post-commit work). |
| No duplicate records | COVERED | COVERED | §1. |
| Concurrent webhooks | COVERED | COVERED | hook "concurrent deliveries of one success confirm it once". |
| Race conditions | COVERED | PARTLY | Advisory lock, row locks, conditional claim. |
| Status ↔ business consistency | COVERED | MISSING | B1 for tickets. |
| Recovery from DB failure | COVERED | COVERED | hook "a database failure while handling". |

### 8. Network reliability
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Timeouts | COVERED | COVERED | `PAYSTACK_TIMEOUT_MS`; client "a timeout is a timeout, and uncertain". |
| Network interruptions | COVERED | COVERED | client "users never see Paystack's own text" (network case). |
| 4xx / 5xx | COVERED | COVERED | client "a 400 is a rejection …", "a 429 is rate_limited, a 503 is server". |
| 429 | COVERED | COVERED | Same; reads honour Retry-After. |
| Paystack down | COVERED | PARTLY | pass "Paystack down is a neutral 503". |
| Failed verify | COVERED | PARTLY | Same test. |
| Retries | COVERED | COVERED | client "a read is retried …", "gives up after two retries". |
| No duplicate charge on retry | COVERED | PARTLY | client "a write is never retried". Tickets: A2. |
| Uncertain outcomes | COVERED | PARTLY | sub "is pending_confirmation and UNCERTAIN, never FAILED; the sync adopts …"; pass "a timeout: … the purchase FAILED" (a later success is still granted). |

### 9. Refunds, reversals and disputes
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Refund processing | COVERED | PARTLY | Refunds issued from Paystack's dashboard, applied by webhook. pass "a full refund removes the pass", sms "a refund removes what was left of its credits", sub "a full refund of the latest charge ends the subscription". Tickets: recorded and alerted only. |
| Refund verification | COVERED | PARTLY | Matched to the original payment; reconciliation's REFUND_NOT_RECORDED (hook "matches what agrees …"). |
| Partial refunds | COVERED | PARTLY | Recorded and alerted, nothing taken back. pass "a partial refund is recorded and alerted". |
| Reversals | COVERED | PARTLY | A lost chargeback: pass "lost: taken back (REVERSED)", sub "a lost chargeback on the latest charge". |
| Chargebacks | COVERED | PARTLY | pass "opened: recorded, access stays, the super admin alerted", "won: recorded", "an outcome we don't recognise". Payload unverified (see STEERING). |
| Refund status tracking | COVERED | MISSING | REFUNDED/REVERSED; REFUND_PENDING, REFUND_FAILED (pass "refund.pending is noted; refund.failed is noted and alerted"). |
| Original record kept | COVERED | COVERED | Append-only ledger; purchase rows kept. |
| Failed vs refunded | COVERED | MISSING | Distinct statuses. |

### 10. Reconciliation and audit
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Internal references | COVERED | COVERED | `relatedType`/`relatedId`. |
| Paystack references | COVERED | PARTLY | `paystackTransactionId` on the ledger and purchases. pass "the signed charge.success grants it". |
| Amounts and currencies | COVERED | COVERED | Every ledger row. |
| Timestamps | COVERED | PARTLY | `occurredAt` from `paid_at`. pass and sub "… with its id and paid_at". |
| Status history | COVERED | PARTLY | A ledger row per transition. |
| Refund records | COVERED | PARTLY | REFUND_ISSUED with its effect. |
| Settlement reconciliation | PARTLY | PARTLY | Settlements counted and totalled per run; not matched one by one (the ledger has no fees). |
| Traceability | COVERED | PARTLY | SUBSCRIPTION_SYNC_CORRECTED with before/after (sub "the sync starts grace"). Subaccount changes: no audit (tickets). |
| Discrepancy detection | COVERED | COVERED | Daily reconciliation. hook "matches what agrees, and lists …", "a run is claimed once per day". |

### 11. Frontend payment experience (frontend release)
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Repeated submissions | COVERED (server) | PARTLY | Reuse/409 on the server; buttons already guard per tab. |
| Accurate messages | *MISSING (frontend)* | *MISSING* | "Your payment was accepted" before proof on the billing, pass and bundle callback pages. |
| Loading states | PARTLY | PARTLY | Existing spinners. |
| Page refresh | PARTLY | PARTLY | Backend: `pendingChange`, `purchaseId`, `POST /verify`; frontend to use them. |
| Abandoned checkout | COVERED (server) | PARTLY | Stale sweep. |
| Pending transactions | PARTLY | PARTLY | Server reuses the checkout link; the frontend shows it. |
| No redirect as proof | COVERED | COVERED | Webhook or verify only. |
| No internal errors | COVERED (server) | PARTLY | Neutral codes; frontend to show them. |

### 12. Testing and edge cases
| Scenario | Release 1 | Tickets | Test |
|---|---|---|---|
| Successful payments | COVERED | PARTLY | pass, sms, sub (first tests) |
| Failed payments | COVERED | MISSING | pass "a failed attempt then a success …" |
| Abandoned payments | COVERED | MISSING | pass "a day-old checkout Paystack calls abandoned" |
| Duplicate requests | COVERED | MISSING | pass "the same tier again reuses", sub "the same plan again reuses" |
| Duplicate webhooks | COVERED | MISSING | pass "the same delivery twice is a duplicate" |
| Invalid signatures | COVERED | COVERED | pass "an invalid signature is 401" |
| Invalid references | COVERED | MISSING | hook "a charge for a reference nobody knows is unhandled and alerted" |
| Incorrect amounts | COVERED | MISSING | pass, sms, sub "wrong amount" tests |
| Incorrect currencies | COVERED | MISSING | pass "a success in the wrong currency" |
| Delayed webhooks | COVERED | MISSING | pass "… the webhook arriving later changes nothing", sub "a late disable …" |
| Browser closed after payment | COVERED | MISSING | pass "reconcile confirms by asking Paystack", sub "POST /verify activates" |
| Concurrent payment requests | COVERED | MISSING | pass "two purchases at the same moment", sub "two at once" |
| Concurrent webhooks | COVERED | MISSING | hook "concurrent deliveries of one success" |
| Paystack API timeouts | COVERED | MISSING | client "a timeout is a timeout", pass "a timeout: a neutral 503", sub "is pending_confirmation …" |
| Database failures | COVERED | MISSING | hook "a database failure while handling" |
| Unauthorised access | COVERED | PARTLY | pass "another tenant can't reconcile", hook "a tenant admin gets the global 404" |
| Refunds and reversals | COVERED | MISSING | pass, sms, sub refund and chargeback tests |

### 13. Production environment (cutover)
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Live public key | *To do* | *To do* | Render; startup refuses a test key in production. |
| Live secret key | *To do* | *To do* | Same. |
| Test/production separation | COVERED | COVERED | client "production needs live keys …". |
| Live webhook URL | *To do* | *To do* | Paystack dashboard. |
| HTTPS | *To do* | *To do* | As §3. |
| Secure configuration | COVERED | COVERED | Missing plan codes and keys stop the app. |
| CORS | COVERED | COVERED | `tests/config`. |
| Production database | *To do* | *To do* | `scripts/sql/payments-cutover-1-check.sql`, then `-2-reset.sql`. |
| Migration readiness | COVERED | COVERED | `20261119090000_payments_release_1`, additive; applied to the test database by the suite. |
| Logging and monitoring | COVERED | PARTLY | Alerts to admin@e-velope.co.za; Sentry for 5xx. |
| Error tracking | COVERED | COVERED | Sentry. |
| Test-mode assumptions removed | COVERED | PARTLY | Plan names, Elevate 1,000 SMS (seed), 2% comments; production's tier row and plan codes are cutover steps. |

### 14. Business logic
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Payment ↔ product | COVERED | COVERED | By reference per table. |
| No paid access without payment | COVERED | MISSING | Hard stop (sub "a paid period that ended over 5 days ago …"), grace (sub "invoice.payment_failed starts the 5-day grace"), refunds. Tickets: B1. |
| No duplicate fulfilment | COVERED | COVERED | §1. |
| Unsuccessful/abandoned | COVERED | PARTLY | §4. |
| Completion ↔ operation | COVERED | PARTLY | §7. |
| Paid then left | COVERED | PARTLY | Webhook, verify, sync, sweep. |
| Payment history | COVERED | PARTLY | Billing history now includes refunds (sub "a full refund of the latest charge …" reads it). |

### 15. e-velope specifics
| Point | Release 1 | Tickets | Evidence |
|---|---|---|---|
| Subaccount confirmation | NOT APPLICABLE | MISSING | Ticket release (A6). |
| Settlement account correct | *To do* | — | Paystack dashboard, before cutover. |
| Statement name and logo | *To do* | — | Paystack dashboard. |
| Plans and subaccounts per mode | COVERED (code) | *To do* | Plan script renamed; live plans and re-onboarding are cutover steps; reset SQL clears test codes. |
| editToken gap | COVERED | — | `tests/rsvp/rsvp-submit-response-shape.test.ts`. |
| Commission 2% | COVERED | *To do* | money "reads PLATFORM_COMMISSION_PERCENT as basis points: 2 is 200"; set on Render. |
| Elevate SMS 1,000 | COVERED (seed) | — | Seed; production's row on the tier screen. |
| Plan names | COVERED | — | `create-subscription-plans.ts`. |
| Gross-up vs Paystack's fee bearer | NOT APPLICABLE | *MISSING* | Ticket release (A7). |