import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { ensureSchema } from "./database/bootstrap";

async function bootstrap() {
  // Run schema initializer BEFORE the Nest factory builds providers — many
  // providers query the DB at construction time, which would crash on a
  // fresh empty DB. ensureSchema is a no-op when tables already exist.
  //
  // Deliberately non-fatal. This runs on EVERY boot and rethrows on any failed
  // passive migration; letting that escape rejects bootstrap(), kills the
  // process, and Coolify restarts it — a crash loop in which the proxy has no
  // healthy backend and every request, including login, gets a 503. A schema
  // problem should degrade the endpoints that need it, not take the whole API
  // down, so it is logged loudly and boot continues.
  try {
    await ensureSchema();
  } catch (err: any) {
    Logger.error(
      `ensureSchema failed — starting anyway; endpoints touching the affected ` +
        `tables may error: ${err?.stack || err?.message || err}`,
      "Bootstrap",
    );
  }

  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api");
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  /**
   * Swagger UI at /api/docs, raw spec at /api/docs-json. Two security schemes
   * because we have two distinct JWT audiences:
   *   - "user-jwt"   → landlord/admin endpoints (JwtAuthGuard)
   *   - "tenant-jwt" → tenant portal endpoints (TenantAuthGuard)
   * Controllers tag the right one via @ApiBearerAuth("user-jwt") or
   * @ApiBearerAuth("tenant-jwt").
   */
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Dara API")
    .setDescription("Property-management API for landlords, tenants, and admins.")
    .setVersion("1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "user-jwt")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "tenant-jwt")
    .build();
  const swaggerDoc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, swaggerDoc, {
    swaggerOptions: { persistAuthorization: true },
  });

  // Close on SIGTERM instead of ignoring it. Docker sends SIGTERM, waits out
  // its 30s grace period, then SIGKILLs — so every deploy spent ~34s in
  // teardown, 14% of an API deploy, purely because nothing was listening for
  // the signal. Nest's shutdown hooks also let providers close their own
  // handles rather than having them severed.
  app.enableShutdownHooks();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      Logger.log(`${signal} received — closing`, "Bootstrap");
      // In-flight requests finish; a hung close must not outlast the grace
      // period, or we are back to being killed.
      const forced = setTimeout(() => process.exit(0), 10_000);
      forced.unref();
      app.close().then(() => process.exit(0)).catch(() => process.exit(0));
    });
  }

  const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}`, "Bootstrap");
  Logger.log(`Swagger UI    on http://localhost:${port}/api/docs`, "Bootstrap");
}

// A rejected bootstrap() used to surface only as an unhandled rejection and a
// bare non-zero exit, which reads in Coolify as "container keeps restarting"
// with no cause. Log the stack, then exit explicitly.
bootstrap().catch((err) => {
  Logger.error(`Fatal: API failed to start — ${err?.stack || err?.message || err}`, "Bootstrap");
  process.exit(1);
});

// Never let a stray rejection from a background task (email send, webhook,
// push) take the process down and 503 every in-flight request.
process.on("unhandledRejection", (reason: any) => {
  Logger.error(`Unhandled rejection: ${reason?.stack || reason}`, "Process");
});
