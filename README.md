# Regulatory Change Impact Agent — Level 1 contracts

This repository contains the Level 1 frontend, shared TypeScript/Zod contracts, synthetic fixtures, and validation tooling. Backend APIs, monitoring workers, database and storage remain Gokul's integration work.

- [API contract](docs/API_CONTRACT.md): wire formats, field/state rules, endpoint registry and processing semantics.
- [Sethu integration guide](docs/SETHU_INTEGRATION.md): imports, examples, implementation status and handoff.
- [Scope and decisions](docs/CONTRACT_DECISIONS.md): inspected baseline, Level 1 traceability and coordination decisions.
- Source of truth: `src/shared/contracts/index.ts` and its exported schemas; public types are inferred from those schemas.

Use Node 22+ and npm:

```sh
npm ci
npm run check
npm run dev
```

Open the local URL printed by Vite. The frontend starts in **Synthetic fixtures** mode, with an always-visible banner. Fixture mutations are disabled. Use the repository's scenario selector to inspect completed extraction, missing/ambiguous predecessors, queued extraction and extraction failure; source run outcome previews are static examples. No synthetic result is presented as a real monitoring run.

Switch to **Live API** to use the exact shared `/api/v1` endpoints. In development, Vite proxies those requests to `http://127.0.0.1:3000`. To use a different local backend in PowerShell:

```powershell
$env:RIA_API_ORIGIN = 'http://127.0.0.1:3000'
npm run dev
```

`npm run build` produces static assets in `dist`; `npm run preview` previews them. Production hosting must route `/api/v1` to the backend on the same origin; the development proxy is not included in static assets. Shared schemas/fixtures are unchanged. Vite is a development dependency; no additional UI framework or backend was introduced.

See [Frontend handoff](docs/SETHU_FRONTEND_HANDOFF.md) for implemented operations, verification steps, and backend gaps.

Fixtures are invented demonstration content, not regulatory advice or verified source configurations.
