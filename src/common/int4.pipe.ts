import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { INT4_MAX } from "./validation";

/**
 * Like Nest's ParseIntPipe, but bounded to what an int4 primary key can hold.
 *
 * The bare pipe accepts any integer, so an id past 2^31 reached the driver and
 * came back as a 500 — an out-of-range id is a bad request, not a server
 * failure, and a 500 on a public route is worth avoiding on its own.
 */
@Injectable()
export class ParseInt4Pipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const raw = String(value ?? "").trim();
    const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > INT4_MAX) {
      throw new BadRequestException("المعرف غير صالح · Invalid id");
    }
    return n;
  }
}
