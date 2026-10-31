# Regulatory Change Impact Agent — Level 1 contracts

This repository contains shared TypeScript/Zod contracts, synthetic fixtures, and a local SQLite backend with monitoring, document ingestion, cited Bedrock extraction and historical comparison. Sethu’s Level 1 frontend is integrated on a separate local branch.

- [API contract](docs/API_CONTRACT.md): wire formats, field/state rules, endpoint registry and processing semantics.
- [Sethu integration guide](docs/SETHU_INTEGRATION.md): imports, examples, implementation status and handoff.
- [Scope and decisions](docs/CONTRACT_DECISIONS.md): inspected baseline, Level 1 traceability and coordination decisions.
- [Backend ingestion checkpoint](docs/BACKEND_INGESTION.md): preserved ingestion foundation and real-source verification.
- [Analysis integration](docs/ANALYSIS_INTEGRATION.md): current endpoints, Bedrock setup, polling, predecessor uploads, review controls, verification and remaining gaps.
- [Analysis coordination notes](docs/ANALYSIS_CONTRACT_PROPOSALS.md): proposed future contract additions; existing shared schemas remain unchanged.
- Source of truth: `src/shared/contracts/index.ts` and its exported schemas; public types are inferred from those schemas.

Use Node 22.13+ and npm:

```sh
npm ci
npm run check
```

Fixtures are invented demonstration content, not regulatory advice or verified source configurations.

See [the current integration guide](docs/LEVEL1_INTEGRATION.md) for startup, credentials, browser verification and remaining blockers. The default frontend mode is Live API; synthetic fixtures remain explicitly labelled and separate. This is a verified integration checkpoint, not completed Level 1 coverage.
