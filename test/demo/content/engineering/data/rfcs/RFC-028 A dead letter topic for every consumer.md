| Status | Implemented |
| -- | -- |
| Created | 2025-03-25 |
| Authors | DemoIvan |
| Reviewers | DemoCarol, DemoDave |
| Target | Q2 2025 |
| Decision | [ADR-005 Use Kafka for domain events](@ADR-005), follow-up |

## Summary

Give every consumer group its own dead letter topic. A message the consumer cannot process after a fixed number of retries goes there with the reason attached, and the partition moves on.

## Motivation

* Since order events moved to Kafka, a single undecodable message has stopped a partition three times; the longest stop held 1/48 of all order notifications for 3 h 20 min.
* Consumers handled failures differently: two skipped silently, one retried forever.
* Nobody could see how many messages had been skipped.

## Proposal

### Retry, then park

A message is retried in place with backoff (100 ms, 1 s, 10 s). If it still fails, the consumer publishes it to `dlq.<consumer-group>` and commits the offset.

@@picture:rfc-028-dlq@@

### What counts as a failure

| Failure | Retried | Parked |
| -- | -- | -- |
| Payload does not decode | no | at once |
| Validation error in the payload | no | at once |
| Dependency timeout (database, API) | yes, 3 times | after retries |
| Sequence gap ([SPEC-016](@SPEC-016)) | no | never: the partition stops and alerts |

A sequence gap stops the partition on purpose: skipping would corrupt the read model.

### Message format

The parked message keeps the original key, headers and payload, and adds headers with the reason. Full format in [SPEC-028](@SPEC-028).

```text
dlq-original-topic:     orders.events
dlq-original-partition: 17
dlq-original-offset:    8812044
dlq-reason:             decode_error
dlq-error:              proto: cannot parse invalid wire-format data
dlq-attempts:           1
```

### Re-drive

A small tool re-publishes parked messages to the original topic after a fix:

```sh
dlqctl redrive --group notify-svc --reason decode_error --since 2025-05-01T00:00:00Z
```

## Alternatives

| Option | Partition stops | Visibility | Why not |
| -- | -- | -- | -- |
| Retry forever | yes | lag alert only | Stops everything behind one message |
| Skip and log | no | logs only | Messages are lost from view |
| One shared dead letter topic | no | yes | Re-drive per consumer gets hard |
| **One dead letter topic per consumer group** | **no** | **yes** | Chosen |

## Rollout

- [X] Library support in the Go Kafka client wrapper
- [X] `notify-svc`, `fulfilment-svc`, `demo-pay` consumers
- [X] Dashboard and alert: more than 10 parked messages in 10 minutes
- [X] `dlqctl` re-drive tool

## Open questions

* Volumes after a year are in [RN-027](@RN-027).
