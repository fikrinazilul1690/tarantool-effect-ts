### `references/http-api.md`

````md
# Effect HttpApi

This repository uses Effect v4 HTTP API APIs.

The relevant APIs may live under unstable modules.

Do not replace the existing HttpApi architecture with Express-style,
manual fetch, or ad-hoc request handlers unless explicitly requested.

## Architecture

Prefer the existing hierarchy:

```text
HttpApi
  └── HttpApiGroup
        └── HttpApiEndpoint
```
````
