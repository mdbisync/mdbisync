# Decision: store invoices as PDF

**Status:** accepted

## Context

Customers ask for invoices they can print and archive.

## Decision

We generate a PDF for every invoice and keep it for seven years.

## Consequences

* Storage grows by about 2 GB a year.
* The billing service needs a PDF library.

## Alternatives

* HTML invoices only: rejected, they do not print consistently.

Ref kx-4792bf7c