### `references/schema.md`

Effect v4 has meaningful Schema differences from v3, and the Effect repository maintains a dedicated v3→v4 migration guide, so explicitly telling the agent not to blindly copy v3 examples is valuable. :contentReference[oaicite:2]{index=2}

````md
# Effect Schema v4

Use these guidelines when working with Effect Schema.

## Version awareness

Effect Schema changed significantly between Effect v3 and Effect v4.

Do not copy v3 Schema code without checking the current v4 API.

When uncertain:

1. inspect the installed `effect` package
2. inspect existing repository usage
3. consult current Effect v4 documentation

## Structs

Prefer:

```ts
const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
```
````
