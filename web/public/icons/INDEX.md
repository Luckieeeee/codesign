# System Design Icon Library

A comprehensive SVG icon library for system-design and software-architecture diagrams.

## Stats
**Total:** 1664 SVG icons across 9 top-level categories.


## Layout

| Folder | Count | What's in it |
|---|---:|---|
| `generic/` | 241 | Hand-authored vendor-neutral icons (compute, data, network, messaging, user, security, observability, primitives, patterns, domain, compliance, file-types, boundaries) |
| `aws/` | 64 | AWS Architecture Icons (Icon-package_01302026) |
| `gcp/` | 47 | Google Cloud official icons (modern + legacy) |
| `azure/` | 57 | Azure Public Service Icons V23 |
| `kubernetes/` | 35 | kubernetes/community + cncf/artwork |
| `open-libs/` | 150 | Feather (49), Heroicons (44), Material (29), Font Awesome (28) — outline / monochrome |
| `tech-logos/` | 126 | simple-icons monochrome single-path logos (CC0) |
| `brand-logos/` | 884 | Colored brand logos — devicon + simple-icons (hex-injected) + iconify + vscode-icons; flat root + curated subfolders (web-frameworks, databases-data, ai-ml-data-apps, hosting-edge-platforms, observability-ops, devtools-ci, ui-design-systems, auth-security, payments-commerce, communications-email, infrastructure-platforms, cms-content, workflow-automation, app-development, backend-api) |
| `brand-logos-extra/` | 60 | Additional colored vendor logos (Temporal, Mistral, LiveKit, Mapbox, Tailscale, Stytch, BentoML, etc.) |

## Generic Subdirectories
- `generic/boundaries/` (9)
- `generic/compliance/` (7)
- `generic/compute/` (10)
- `generic/data/` (13)
- `generic/domain/` (88)
- `generic/file-types/` (10)
- `generic/messaging/` (10)
- `generic/network/` (14)
- `generic/observability/` (8)
- `generic/patterns/` (38)
- `generic/primitives/` (14)
- `generic/security/` (10)
- `generic/user/` (10)

## Open-libs Subdirectories
- `open-libs/feather/` (49) — MIT
- `open-libs/heroicons/` (44) — MIT
- `open-libs/material/` (29) — Apache-2.0
- `open-libs/fontawesome/` (28) — CC-BY-4.0

## Conventions

- **Filenames:** lowercase-kebab-case, descriptive. Cloud icons are prefixed (`aws-lambda.svg`, `gcp-bigquery.svg`, `azure-cosmos-db.svg`, `k8s-pod.svg`).
- **Generic icons:** 24×24 viewBox, `stroke="currentColor"`, `fill="none"`, `stroke-width="1.5"`. Recolor via CSS `color`.
- **Cloud / `brand-logos*` icons:** ship in official brand colors. Treat as fixed-style.
- **Open-libs:** keep their library's native style (Feather/Heroicons strokes, FontAwesome/Material fills).
- **`tech-logos`:** simple-icons monochrome — use `fill: <hex>` from the brand to colorize.

## Why some folders are monochrome

- `tech-logos/`, `feather/`, `heroicons/`, and most `kubernetes/` icons are intentionally single-color so consumers can recolor with CSS or hex injection. For pre-colored brand logos use `brand-logos/` and `brand-logos-extra/`.

## Sources & Licenses

| Folder | Source | License |
|---|---|---|
| `generic/` | hand-authored | project-owned |
| `aws/` | AWS Architecture Icons (2026 pkg) | AWS trademark guidelines |
| `gcp/` | Google Cloud official icon zips | Google brand guidelines |
| `azure/` | Microsoft Azure Public Service Icons V23 | Microsoft brand guidelines |
| `kubernetes/` | github.com/kubernetes/community + cncf/artwork | CC-BY |
| `open-libs/feather/` | feathericons | MIT |
| `open-libs/heroicons/` | tailwindlabs/heroicons | MIT |
| `open-libs/material/` | Templarian/MaterialDesign-SVG | Apache-2.0 |
| `open-libs/fontawesome/` | FortAwesome/Font-Awesome (free) | CC-BY-4.0 |
| `tech-logos/` | simple-icons | CC0 |
| `brand-logos/` | devicon (MIT) + simple-icons (CC0, hex-injected) + iconify/logos + vscode-icons | mixed permissive |
| `brand-logos-extra/` | simple-icons + gilbarbara/logos + vectorlogo.zone + selfh.st + svgl + devicon | mixed permissive |

Logos remain subject to vendor trademarks regardless of underlying license.

## Coverage Notes

- 75 software-system archetypes were surveyed (web/mobile/microservices/event-driven/streaming/social/search/fintech/blockchain/ad-tech/healthcare/IoT/edge/serverless/gaming/AR-VR/LLM-RAG/MLOps/agents/workflow/etc.). Components were decomposed and matched to icons.
- Generic patterns covered: circuit-breaker, bulkhead, saga, outbox, sidecar, sharding, leader-election, gossip, consensus, blue-green, canary, CDC, rate-limiter, idempotency, dead-letter, backpressure, etc.
- Domain components covered: RAG pipeline, embedding model, vector DB, GPU/TPU worker, SFU/MCU, TURN/STUN, DRM, CDP/DMP/SSP/DSP, RTB, FHIR/HL7/DICOM, geofence, surge pricing, KYC/AML, order matching, market data feed, etc.
- Compliance badges: HIPAA, GDPR, PCI-DSS, SOC 2, ISO 27001, CCPA, FedRAMP.
- File types: parquet, avro, protobuf, yaml, xml, csv, json, markdown, log, excel.
- Boundaries: data-residency, sovereignty, tenant, trust, blast-radius, network-zone, DMZ, public/private subnet.

## Known Gaps

- `aws-data-pipeline` (service deprecated).
- `k8s-endpoint-slice` (no upstream icon).
- ~44 proprietary B2B SaaS brands lack any open colored SVG (e.g. Confluent, Plaid, Mux, Statsig, LaunchDarkly, CrowdStrike, SentinelOne, Wiz, Recurly, Zuora). These would need to be sourced from vendor brand kits under proprietary terms.
