# Benchmark Dashboard

Standalone in-repo Vite+React application for visualizing Munder Difflin benchmark outputs.

## Setup & Running

This dashboard uses the repository's root `package.json` dependencies (plus `recharts`).

Run the dashboard from the repo root:
```bash
npm run dashboard:dev
```

To build for production:
```bash
npm run dashboard:build
```

## Data Loading
The dashboard reads JSON/JSONL output files from the `HIVE_ROOT` directory.
- `log.jsonl` (event log)
- `cost-ledger.jsonl` (cost metrics)
- `tasks.json` (task states and scores proxy)
- `results.jsonl` (optional, explicit score data)

You can override the `HIVE_ROOT` path in the dashboard's top bar.

## Architecture
- Standalone Vite configuration using a custom middleware plugin (`plugin/hiveData.ts`) to serve local files.
- Uses Recharts for visualization.
