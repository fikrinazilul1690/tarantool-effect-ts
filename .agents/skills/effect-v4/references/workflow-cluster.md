### `references/workflow-cluster.md`

````md
# Effect Workflow and Cluster

Use this reference for `@effect/workflow`, `@effect/cluster`, durable execution,
activities, retries, and distributed workflow code.

## Mental model

A workflow describes orchestration.

Cluster provides distributed execution/infrastructure capabilities.

When they are combined for durable execution, separate:

```text
workflow/orchestration
        ↓
durable step/activity
        ↓
external side effect
```
````
