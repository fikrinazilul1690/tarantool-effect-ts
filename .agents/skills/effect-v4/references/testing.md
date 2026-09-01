### `references/testing.md`

````md
# Effect Testing

Test behavior at the appropriate Effect boundary.

## Services

Prefer test Layers/services over global mocks when testing Effect services.

Supply deterministic implementations for dependencies such as:

- clock
- database
- HTTP services
- ID generation
- external APIs

when appropriate.

## Errors

Test typed failures explicitly.

Do not test only the formatted error message when the error has a meaningful
tag or structured fields.

Prefer asserting the error model itself.

## Schema

Schema tests should cover important boundaries:

- valid decoding
- invalid decoding
- encoded representation
- transformations
- filters

Do not duplicate exhaustive tests for behavior already guaranteed by Effect
unless the schema expresses important domain rules.

## Workflows

For workflow code, test orchestration independently where possible.

Important cases include:

- successful execution
- activity failure
- retries
- non-retryable failures
- compensation
- duplicate/idempotent execution
- recovery after interruption

## Reactivity

For Atom code, verify state transitions rather than implementation details.

For asynchronous atoms/mutations, test:

```text
initial → waiting → success
```
````
