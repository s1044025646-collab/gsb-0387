export type ErrorCode =
  | "INVALID_NODE"
  | "INVALID_ARITY"
  | "INVALID_VAR_NAME"
  | "TOO_MANY_NODES"
  | "TOO_DEEP"
  | "MISSING_ASSIGNMENT"
  | "NON_BOOLEAN_ASSIGNMENT"
  | "NOT_FOUND"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
