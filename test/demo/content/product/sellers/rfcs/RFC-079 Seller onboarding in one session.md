| Status | In review |
| -- | -- |
| Created | 2026-02-24 |
| Authors | DemoLaura |
| Reviewers | DemoNina, DemoPeggy, DemoErin |
| Target | Q1 2027 |
| Evidence | [RN-070 Seller onboarding drop-off](@RN-070) |

## Summary

Let a new seller go from sign-up to a published first listing in one sitting of about 20 minutes, by running the identity check in the background, asking for bank details later, and starting the first listing while the checks run.

## Motivation

Only 41 % of sellers who start sign-up publish a first listing, and only 24 % make a sale within 30 days ([RN-070](@RN-070)). The biggest loss is at the identity check: sellers wait a median of 31 minutes for it, on a page that does nothing, and 18 % of them never come back. Today the steps are strictly in order: business details, identity check, bank account, then the first listing.

## Proposal

@@picture:rfc-079-flow@@

### Run checks in parallel

* The identity check starts as soon as business details are in, and runs in the background.
* The seller goes straight on to the first listing. The listing is saved as a draft and published automatically when the check passes.
* Bank details are asked for before the first payout, not before the first listing. A seller can sell without them; the money waits in their balance ([SPEC-081](@SPEC-081)).

### Account states

The [seller account model](@SPEC-078) gains one state, `listing_allowed`, between `pending_verification` and `active`:

```graphql
enum SellerAccountState {
  PENDING_VERIFICATION
  LISTING_ALLOWED
  ACTIVE
  RESTRICTED
  CLOSED
}
```

In `LISTING_ALLOWED` a seller can create drafts and the listing quality check runs ([SPEC-085](@SPEC-085)), but nothing is visible to buyers until the identity check passes.

### Telling the seller

When the check passes or needs more documents, the seller is told in Seller Hub and by push in the app, through [notify-svc](@ADR-039).

## Alternatives

| Option | Expected publish rate | Risk | Why not |
| -- | -- | -- | -- |
| Faster identity provider only | 45 % | none | Saves 10 minutes; still a dead wait |
| Skip the identity check until the first sale | 58 % | listings from unverified sellers are visible | Not allowed for us |
| **Checks in the background, listing in parallel** | **55 %** | **none: nothing is visible before the check** | Proposed |

The expected rates come from the step timings in [RN-070](@RN-070), assuming the identity check loses half as many sellers when nobody waits for it.

## Rollout

- [ ] Review with the risk team (in progress)
- [ ] `LISTING_ALLOWED` state and draft auto-publish
- [ ] New flow for 20 % of sign-ups, compared for 6 weeks
- [ ] Bank details moved before the first payout

## Open questions

* What happens to drafts if the identity check fails? Proposal: keep them 30 days, so a seller who uploads better documents loses nothing.
* Should a seller in `LISTING_ALLOWED` see the [bulk editor](@RFC-074)? Probably not; first listings come one at a time.
