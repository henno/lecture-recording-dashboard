# Repository Guidelines

## Project Structure & Module Organization
The backend logic lives under `src/`, with `src/index.ts` serving HTTP routes, `src/fetch-lesson-times.ts` populating lesson metadata, and `src/sync-google-drive.ts` reconciling Drive state. Frontend assets are in `public/` and load directly via the Bun dev server. Generated artifacts populate `data/` (cached schedules, OCR snapshots, upload queues) and `debug_frames/` (diagnostic images); keep these out of version control. Environment-specific configuration such as OAuth credentials belongs in `config/`, using the `.example` files as templates. Temporary scratch work can sit in `temp/` or `manual_debug/` but should be cleared before merging.

## Build, Test, and Development Commands
Install dependencies with `bun install`. Use `bun run dev` for live-reload development, and `bun run start` to exercise the production entry path. Pre-populate caches and rescan the Zoom directory with `bun run fetch`. Synchronize Google Drive metadata locally with `bun run sync`. When a command touches external services, confirm the required files exist in `config/`.

## Coding Style & Naming Conventions
This codebase is TypeScript-first under strict compiler settings (`tsconfig.json`); keep modules ESNext-compatible and prefer explicit return types on exported functions. Follow the prevailing two-space indentation and trailing commas where they aid diffs. Internal helpers should use camelCase, while long-running jobs and concurrency guards receive descriptive class names (`FfmpegSemaphore`). Stick with Bun’s native APIs (e.g., `serve`) and centralize filesystem paths via `path.join` for portability.

## Testing Guidelines
There is no automated test harness yet; regression checks rely on targeted manual validation. Before submitting changes, run `bun run fetch` to confirm new logic still discovers lessons and `bun run dev` to smoke-test the dashboard at `http://localhost:3000`. For media-processing updates, inspect `debug_frames/` outputs and clear relevant caches in `data/` to ensure fresh OCR runs. If you add tests, colocate them beside their modules using a `.test.ts` suffix so future tooling can pick them up.

## Commit & Pull Request Guidelines
Commit history follows Conventional Commits (`feat:`, `fix:`, `docs:`). Use the same verbs, keep scopes small, and reference the primary behavior change. Pull requests should include: a concise summary, reproduction steps or screenshots for UI tweaks, confirmation of the Bun scripts executed, and notes on any data directory impacts. Flag configuration changes that require teammates to refresh `config/` files or regenerate OAuth tokens. Ensure PR titles mirror the Conventional Commit format to keep release notes consistent.
