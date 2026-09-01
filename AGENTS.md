# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the Bun/TypeScript application. Effect services and layers live in `src/db.ts` and `src/auth/`; schema-first HTTP contracts, middleware, and handlers are in `src/api/`. Tarantool topology and Lua stored functions are under `tarantool/`. Runnable lessons belong in `examples/`, while Bun integration tests live in `test/`. Keep connector declarations in `types/` and importable API examples in `postman/`. Docker infrastructure is defined by `compose.yaml` and `Dockerfile`; local database state under `data/` is generated and must not be committed.

## Build, Test, and Development Commands

- `bun install` installs TypeScript, Effect, Better Auth, and connector dependencies.
- `make start` builds and starts the router, two vshard storages, and community UI.
- `make api` starts the Effect `BunHttpServer` on port 3000; `make api-watch` reloads during development.
- `bun run typecheck` runs strict TypeScript checking without emitting files.
- `bun test` runs live integration tests against the Docker cluster.
- `make examples` executes all numbered learning examples.
- `make logs`, `make status`, and `make stop` inspect or stop the cluster.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, semicolons, and strict types. Name Effect services and layers in PascalCase, ending implementations with `Live` (for example, `TarantoolDbLive`). Keep API schemas declarative and return database failures through typed Effect errors. Lua functions use snake_case and are grouped under `api` or `storage_api`. No formatter or linter is configured, so match surrounding code and always run `bun run typecheck`.

## Testing Guidelines

Tests use `bun:test` and follow `*.test.ts`. Add integration coverage for router calls, pagination boundaries, authentication failures, and response schemas. Start Docker with `make start` before testing. Use unique IDs/emails based on timestamps because data persists between runs.

## Commit & Pull Request Guidelines

This repository currently has no commit history. Use concise imperative subjects, preferably Conventional Commit prefixes such as `feat: add protected users endpoint` or `fix: preserve fetch_pos cursor`. Pull requests should explain behavior changes, list verification commands, link relevant issues, and update README/Postman examples when APIs change. Include screenshots only for community UI changes.

## Security & Configuration

Copy `.env.example` to `.env` and replace the development Better Auth secret. Never commit credentials, session tokens, generated data, or production connection details. Treat Tarantool Admin and exposed storage ports as local-development tools only.
