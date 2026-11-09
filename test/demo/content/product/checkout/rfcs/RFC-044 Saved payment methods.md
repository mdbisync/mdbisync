| Status | Implemented |
| -- | -- |
| Created | 2025-04-15 |
| Authors | DemoHeidi |
| Reviewers | DemoKen, DemoCarol |
| Target | Q3 2025 |
| Decision | [ADR-028 Encrypt personal data at the field level](@ADR-028) for the stored details |

## Summary

Let signed-in buyers save a card at checkout and pay with it next time by confirming the security code only. DemoMart stores a token from the card vault and the card's brand, last four digits and expiry, never the card number.

## Motivation

Returning buyers type their card again on every order. On phones the card form takes a median of 38 seconds and 9 % of payment errors are typing mistakes. Saved cards are standard for buyers in our markets: in FR and ES a third of card payments at comparable shops use one.

## Proposal

### Where the card number goes

@@picture:rfc-044-vault@@

The card form uses the vault's hosted fields: the number never touches DemoMart's servers, which keeps us out of the strictest card data audit scope. The vault returns a reusable token after a zero-amount verification.

### What we store

| Field | Example | Stored by | Notes |
| -- | -- | -- | -- |
| `token` | `vt_9fK2mQ` | demo-pay | Opaque; useless outside our vault account |
| `brand` | `visa` | demo-pay | For the icon |
| `last4` | `4242` | demo-pay | Shown as "ending 4242" |
| `expiry` | `2028-07` | demo-pay | Expired cards are hidden |
| `buyer_id` | `byr_31xQ` | demo-pay | Encrypted at the field level |

### Paying with a saved card

The buyer picks the card and types its security code, which goes to the vault the same way as a new card. Strong customer authentication still applies ([RFC-049](@RFC-049)); a saved card often qualifies for an exemption.

### Removing cards

Buyers can remove a card in their account. The token is deleted at the vault, and our row is deleted, not marked.

## Alternatives

| Option | Card data scope | Effort | Why not |
| -- | -- | -- | -- |
| Store card numbers ourselves, encrypted | full audit scope | large | Risk and audit cost |
| Wallet buttons only | none | small | Covers 8 to 14 % of buyers |
| **Vault tokens** | **reduced scope** | **medium** | Chosen |

## Rollout

- [X] Vault account and hosted fields in staging
- [X] Save card on the web, behind a flag
- [X] Save card in the app
- [X] Saved cards on by default for all signed-in buyers

## Open questions

* Should cards expire from our list after 18 months without use? Proposed for the next privacy review.
