# Regulatory Change Impact Agent — Level 1

For the local presentation, use **`npm run demo`**. It starts the authenticated frontend, backend and worker together using `.data/level1-demo`. Do not start separate backend/worker terminals for this mode. See [the presentation guide](docs/LEVEL1_DEMO_PRESENTATION.md) for the exact demo path, saved evidence, uploads and optional live Bedrock mode.

See [REAL_SOURCE_REPAIR.md](docs/REAL_SOURCE_REPAIR.md) for the local real-source repair, approved monitored HTML contract 1.1.0, diagnostics and historical RBI verification.

This repository contains the integrated frontend, shared TypeScript/Zod contracts, synthetic fixtures, and a local SQLite backend with monitoring, document ingestion, cited Bedrock extraction and historical comparison.

- [API contract](docs/API_CONTRACT.md): wire formats, field/state rules, endpoint registry and processing semantics.
- [Sethu integration guide](docs/SETHU_INTEGRATION.md): imports, examples, implementation status and handoff.
- [Scope and decisions](docs/CONTRACT_DECISIONS.md): inspected baseline, Level 1 traceability and coordination decisions.
- [Backend ingestion checkpoint](docs/BACKEND_INGESTION.md): preserved ingestion foundation and real-source verification.
- [Analysis integration](docs/ANALYSIS_INTEGRATION.md): current endpoints, Bedrock setup, polling, predecessor uploads, review controls, verification and remaining gaps.
- [Analysis coordination notes](docs/ANALYSIS_CONTRACT_PROPOSALS.md): proposed future contract additions; the approved monitored HTML extension is documented in the repair guide.
- Source of truth: `src/shared/contracts/index.ts` and its exported schemas; public types are inferred from those schemas.

Use Node 22.13+ and npm:

```sh
npm ci
npm run check
```

Fixtures are invented demonstration content, not regulatory advice or verified source configurations.

See [the Level 1 verification status](docs/LEVEL1_STATUS.md) for bounded source coverage and remaining limitations, and [the integration guide](docs/LEVEL1_INTEGRATION.md) for the earlier integration checkpoint. Synthetic fixtures remain explicitly labelled and separate from saved real evidence.
