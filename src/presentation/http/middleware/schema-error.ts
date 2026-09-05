import { Effect, SchemaIssue } from "effect";
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi";
import { ValidationErrorResponse, validationErrorResponse } from "../schemas";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export class RequestSchemaError extends HttpApiMiddleware.Service<RequestSchemaError>()(
  "learn-tarantool/api/RequestSchemaError",
  { error: ValidationErrorResponse },
) { }

export const RequestSchemaErrorLive =
  HttpApiMiddleware.layerSchemaErrorTransform(
    RequestSchemaError,
    (schemaError) => {
      if (isRequestError(schemaError.kind)) {
        return Effect.fail(
          validationErrorResponse(
            `${schemaError.kind} validation failed`,
            groupIssuesByField(schemaError.cause.issue),
          ),
        );
      }
      // Response encoding failures are server defects, not invalid user input.
      return Effect.fail(schemaError);
    },
  );

function isRequestError(
  kind: HttpApiError.HttpApiSchemaError["kind"],
): kind is "Params" | "Headers" | "Query" | "Payload" {
  return (
    kind === "Params" ||
    kind === "Headers" ||
    kind === "Query" ||
    kind === "Payload"
  );
}

function groupIssuesByField(
  issue: SchemaIssue.Issue,
): Record<string, ReadonlyArray<string>> {
  const fields: Record<string, Array<string>> = {};
  for (const formatted of formatIssues(issue).issues) {
    const field =
      formatted.path
        ?.map((segment) =>
          String(typeof segment === "object" ? segment.key : segment),
        )
        .join(".") || "_root";
    (fields[field] ??= []).push(formatted.message);
  }
  return fields;
}
