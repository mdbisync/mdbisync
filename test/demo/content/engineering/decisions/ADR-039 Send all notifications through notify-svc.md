| Status | Accepted |
| -- | -- |
| Date | 2026-05-24 |
| Authors | DemoNina |
| Reviewers | DemoLaura, DemoDave |

## Context

Emails, push notifications and text messages are sent by six services, each with its own provider client and templates. Buyers get two "order shipped" emails when `fulfilment-svc` and `orders-svc` both react to a shipment. Push preferences set in the app ([RFC-066](@RFC-066)) are ignored by four of the six senders, and nobody can answer how many messages a buyer got last week.

## Decision

All messages to buyers and sellers are sent by `notify-svc` **only**. Other services publish domain events; `notify-svc` decides whether, how and when to send.

* `notify-svc` consumes order, payment and shipment events and maps them to messages with rules per event type.
* It checks preferences and quiet hours, deduplicates by event id and message type, and limits marketing messages to three a week per person.
* Channels: email, push (payloads in [SPEC-070](@SPEC-070)) and text messages for delivery updates.
* Transactional templates such as the order confirmation ([SPEC-055](@SPEC-055)) live in `notify-svc`.
* `notify-svc` is rewritten in Go as part of this change ([ADR-003](@ADR-003)).

```yaml
rules:
  - event: orders.order.shipped.v1
    message: order-shipped
    channels: [push, email]
    fallback: email
    dedupe_window: 24h
  - event: payments.refund.completed.v1
    message: refund-completed
    channels: [email]
```

## Options considered

| Option | Duplicate messages | Preferences respected | Services with provider credentials | Verdict |
| -- | -- | -- | -- | -- |
| **One notification service, event-driven** | **deduplicated** | **everywhere** | **1** | **Chosen** |
| Shared library in each sender | still possible | if every team updates | 6 | Rules spread across teams |
| Third-party messaging platform | deduplicated | yes | 1 | Cost per message at our volume |
| Six senders (today) | 2.3 % of orders | 2 of 6 senders | 6 | The problem we have |

## Consequences

* One place to change a message, a rule or a provider.
* Services lose the ability to send directly; a new message is a rule, not code in the producer.

## Follow-up

- [X] Order and shipment messages from `notify-svc`
- [ ] Payment and refund messages
- [ ] Remove provider credentials from the other five services
