import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import { ZodError } from "zod/v4";
import type { Response } from "express";

/**
 * A malformed query string is a bad request, not a server failure.
 *
 * Every list endpoint parses its query with `listQuerySchema`, and nothing
 * caught what that throws — so `?pageSize=201`, `?page=0`, `?page=abc` and
 * `?order=ASC` all answered 500 with a stack trace, on every list in the
 * product. One past the documented cap is the easiest of those to hit by hand.
 */

/**
 * The 400 a Zod failure turns into — status, body and a one-line summary for
 * the log.
 *
 * Extracted from the filter because there are now TWO filters that can see a
 * `ZodError`: this one and the catch-all `AllExceptionsFilter`. Which of them
 * Nest reaches first depends on the order global filters happen to be
 * registered in, which is not a thing any behaviour should rest on — so both
 * build their answer here and the client gets the same bytes either way.
 */
export function zodErrorResponse(error: ZodError): {
  status: number;
  body: Record<string, unknown>;
  summary: string;
} {
  // `path` names the parameter the caller got wrong, which is the only part
  // of a Zod error worth showing them.
  const fields = error.issues.map((i) => ({
    field: i.path.join(".") || "(query)",
    message: i.message,
  }));
  const named = fields.map((f) => f.field).filter((f) => f !== "(query)");
  return {
    status: 400,
    body: {
      statusCode: 400,
      error: "Bad Request",
      message: named.length
        ? `قيمة غير صالحة في: ${named.join("، ")} · Invalid value for: ${named.join(", ")}`
        : "طلب غير صالح · Invalid request",
      fields,
    },
    summary: `rejected query: ${JSON.stringify(fields)}`,
  };
}

@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(ZodExceptionFilter.name);

  catch(error: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, summary } = zodErrorResponse(error);
    this.log.warn(summary);
    res.status(status).json(body);
  }
}
