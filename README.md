# Regulatory Change Impact Agent — Level 1 contracts

This repository contains shared TypeScript/Zod contracts, synthetic fixtures, and a local SQLite-backed ingestion backend with a monitoring worker. No frontend or Bedrock integration is included.

- [API contract](docs/API_CONTRACT.md): wire formats, field/state rules, endpoint registry and processing semantics.
- [Sethu integration guide](docs/SETHU_INTEGRATION.md): imports, examples, implementation status and handoff.
- [Scope and decisions](docs/CONTRACT_DECISIONS.md): inspected baseline, Level 1 traceability and coordination decisions.
- [Backend ingestion checkpoint](docs/BACKEND_INGESTION.md): working endpoints, local setup, Sethu connection examples, real-source verification and limitations. This is the current implementation status; the foundation documents' original “planned” notes describe the earlier setup commit.
- Source of truth: `src/shared/contracts/index.ts` and its exported schemas; public types are inferred from those schemas.

Use Node 22.13+ and npm:

```sh
npm ci
npm run check
```

Fixtures are invented demonstration content, not regulatory advice or verified source configurations.
