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
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(ZodExceptionFilter.name);

  catch(error: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    // `path` names the parameter the caller got wrong, which is the only part
    // of a Zod error worth showing them.
    const fields = error.issues.map((i) => ({
      field: i.path.join(".") || "(query)",
      message: i.message,
    }));
    const named = fields.map((f) => f.field).filter((f) => f !== "(query)");
    this.log.warn(`rejected query: ${JSON.stringify(fields)}`);
    res.status(400).json({
      statusCode: 400,
      error: "Bad Request",
      message: named.length
        ? `قيمة غير صالحة في: ${named.join("، ")} · Invalid value for: ${named.join(", ")}`
        : "طلب غير صالح · Invalid request",
      fields,
    });
  }
}
