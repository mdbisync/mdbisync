# Demo corpus

The documents of **DemoCompany**, a made-up company, for screenshots and
videos of a Git repository's Markdown documents shown in Linear. It is not
test data: everything in it is tidy, linked and in Linear's form.

```sh
node test/demo/generate.ts --out <dir> [--replace]
```

`content/` holds the documents in the demo repository's folder layout;
`data/` holds the numbers that charts and diagrams are drawn from;
`generate.ts` builds the tree (see its header for the directives). The
pictures are PNG, drawn by `pictures.ts` on `raster.ts` with text from a
DejaVu Sans glyph atlas (`font/`, see `font/LICENSE`), so the output does
not depend on the fonts or tools of the machine that builds it.

## The world

DemoCompany runs **DemoMart**, an online marketplace where independent
sellers list products and buyers order them on the web and in the DemoMart
mobile app. It is obviously not a real company: every product, service and
person carries the `Demo` prefix, and all numbers are invented.

- Products: the DemoMart web shop, the DemoMart app (iOS and Android),
  DemoMart Seller Hub (the sellers' web console), and the DemoMart public
  API with its webhooks.
- Services: `catalog-svc`, `search-svc`, `cart-svc`, `checkout-svc`,
  `demo-pay` (payments), `orders-svc`, `fulfilment-svc`, `notify-svc`,
  `identity-svc`, `api-gateway`, `events-pipeline`, `reco-svc`
  (recommendations), `home-svc` (the app's server-driven home screen), `ads-auction`
  (sponsored listings), `recon-svc` (payment reconciliation), `backfill-svc`
  (event backfills).
- Technology: Kubernetes on a public cloud, PostgreSQL 16, Kafka, ClickHouse,
  Redis, OpenSearch, gRPC inside and REST plus webhooks outside, TypeScript
  for the web, Go for most services, Kotlin and Swift for the app,
  OpenTelemetry, Terraform, Argo CD. Hosts and URLs use `example.com`.
- People appear only as placeholders of the form `Demo<Name>`: DemoAlice,
  DemoBob, DemoCarol, DemoDave, DemoErin, DemoFrank, DemoGrace, DemoHeidi,
  DemoIvan, DemoJudy, DemoKen, DemoLaura, DemoMike, DemoNina, DemoOscar,
  DemoPeggy. They appear as authors, reviewers and owners in status
  tables, and nowhere else. No other personal data: no emails, handles,
  phone numbers or surnames. Customers and sellers are never named; at
  most "a seller of handmade furniture".
- Time: documents are dated from January 2025 to October 2026.

## Writing rules

- Kinds: ADRs, RFCs, research notes and specifications. Every document
  makes or records a plausible technical decision with numbers.
- The title is the file name: `ADR-014 Use Kafka for domain events.md`. No
  H1 heading in the body; the body starts with the status table.
- Linear's form: `*` bullets, `- [ ]` and `- [X]` task items, tables with
  `| -- |` separators and no alignment, fenced code with a language,
  `mermaid` fences for diagrams, `> [!NOTE]` style alerts. No footnotes,
  link titles, image titles, emphasis around inline code, backslash line
  breaks or HTML. `fix` runs on every file, and `lint` must find nothing.
- Links between documents by id: `[the event schema](@SPEC-021)`.
- Never name tools that sync documents, test setups or real companies'
  private data. Real open-source technologies are fine.
