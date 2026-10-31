# Regulatory Change Impact Agent — Level 1 contracts

This repository currently contains shared TypeScript/Zod contracts, synthetic fixtures, and validation tooling. It does **not** contain a frontend, backend, monitoring worker, database, or implemented HTTP endpoints.

- [API contract](docs/API_CONTRACT.md): wire formats, field/state rules, endpoint registry and processing semantics.
- [Sethu integration guide](docs/SETHU_INTEGRATION.md): imports, examples, implementation status and handoff.
- [Scope and decisions](docs/CONTRACT_DECISIONS.md): inspected baseline, Level 1 traceability and coordination decisions.
- Source of truth: `src/shared/contracts/index.ts` and its exported schemas; public types are inferred from those schemas.

Use Node 22+ and npm:

```sh
npm ci
npm run check
```

Fixtures are invented demonstration content, not regulatory advice or verified source configurations.
