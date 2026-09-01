---
name: effect-v4
description: Work with Effect TS v4 in this repository. Use when implementing, reviewing, debugging, or refactoring code involving Effect, Schema, HttpApi, Atom/reactivity, Workflow, Cluster, Layers, Services, error handling, concurrency, or Effect-based tests.
---

# Effect v4

Use this skill whenever working with Effect TS code in this repository.

This repository uses Effect v4. Do not assume examples or APIs from
Effect v3 are valid.

## First steps

Before changing Effect-related code:

1. Inspect `package.json` to determine the installed Effect version.
2. Inspect nearby code for established project conventions.
3. Search the installed Effect package or current Effect v4 documentation
   before introducing an unfamiliar API.
4. Prefer the existing architecture over introducing another abstraction.
5. Make the smallest change that solves the problem.

Do not rewrite working Effect code simply because another style is possible.

## Effect fundamentals

Prefer Effect-native abstractions when operating inside Effect code.

Prefer:

- `Effect.gen` for readable sequential workflows
- `Effect.fn` / `Effect.fnUntraced` for reusable Effect functions
- typed errors rather than throwing
- `Layer` for service construction and dependency wiring
- `Context` / Effect services for dependencies
- `Schema` for validation, decoding, encoding, and transport contracts
- Effect concurrency primitives instead of manually coordinating Promises

Avoid unnecessary conversions between `Effect` and `Promise`.

Do not call `Effect.runPromise` inside application Effect code unless
crossing an actual Effect/non-Effect boundary.

## Errors

Expected application failures belong in the Effect error channel.

Do not use exceptions for expected domain failures.

Prefer tagged domain errors when callers need to distinguish failures.

Example:

```ts
import { Schema } from "effect";

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  {
    userId: Schema.String,
  },
) {}
```
