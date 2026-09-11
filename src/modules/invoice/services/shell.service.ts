import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string | Buffer;
  stderr: string;
}

export interface RunOptions {
  input?: Buffer | string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: "utf8" | "buffer";
  /**
   * Wall-clock limit. Defaults to `DEFAULT_RUN_TIMEOUT_MS`; 0 or a negative
   * value disables it, which nothing should want.
   */
  timeoutMs?: number;
}

/**
 * How long any shelled-out command may run before it is killed.
 *
 * There was no limit at all, which is only invisible while every child exits.
 * The children here are `openssl`, `xmllint`, `xsltproc` — milliseconds — and
 * headless Chrome, which is the one that hangs: a wedged renderer never closes
 * its stdio, so the promise never settles, and the invoice path that calls it
 * is fire-and-forget, so nobody is waiting to notice. The process, its tab and
 * its temp directory then leak for the life of the container.
 *
 * Two minutes is deliberately far above anything legitimate (the slowest real
 * render measured is a couple of seconds) and far below "forever". It is a
 * dead-man's switch, not a performance budget: a command that hits it is broken
 * rather than slow, and the caller gets an error it can log instead of a
 * promise that never resolves.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/** Grace between SIGTERM and SIGKILL, so a child can still flush and clean up. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Thin promise wrapper around `child_process.spawn`. We need this because
 * the ZATCA signing pipeline shells out to `openssl`, `xmllint`, `xsltproc`
 * — there is no first-party Node binding for ZATCA's hash-transform XSL or
 * for ECDSA-secp256k1, so the CLI tools are the simplest reliable option.
 */
@Injectable()
export class ShellService {
  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (c) => stdoutChunks.push(c));
      child.stderr.on("data", (c) => stderrChunks.push(c));

      const limit = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timer = limit > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            // Chrome in particular can ignore SIGTERM when it is wedged, which
            // is exactly the case this exists for.
            killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
            killTimer.unref();
          }, limit)
        : null;
      // Unref'd so a pending kill timer is never the reason a SIGTERM'd
      // container sits out its whole grace period; the child handle keeps the
      // loop alive on its own while it is actually running.
      timer?.unref();
      const clear = () => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };

      child.on("error", (err) => { clear(); reject(err); });
      child.on("close", (code) => {
        clear();
        const stdoutBuf = Buffer.concat(stdoutChunks);
        const stdout = opts.encoding === "buffer" ? stdoutBuf : stdoutBuf.toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (timedOut) {
          const err = new Error(`${cmd} timed out after ${limit}ms and was killed`);
          (err as any).timedOut = true;
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ code, stdout, stderr });
      });

      if (opts.input != null) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  async mustRun(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const r = await this.run(cmd, args, opts);
    if (r.code !== 0) {
      const err = new Error(`${cmd} exited ${r.code}: ${r.stderr || (typeof r.stdout === "string" ? r.stdout : "")}`);
      (err as any).stdout = r.stdout;
      (err as any).stderr = r.stderr;
      (err as any).code = r.code;
      throw err;
    }
    return r;
  }
}
