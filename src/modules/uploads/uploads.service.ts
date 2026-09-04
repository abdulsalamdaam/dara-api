import { Injectable, Logger, ServiceUnavailableException, BadRequestException } from "@nestjs/common";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { sanitizeFolder, scopedFolder } from "./key-scope";

export interface UploadResult {
  key: string;
  bucket: string;
  size: number;
  contentType: string;
  originalName: string;
}

export interface UploadOptions {
  /** Optional folder prefix inside the bucket, e.g. "maintenance/123". */
  folder?: string;
  /** Override the random filename with a deterministic one (still namespaced under folder). */
  filename?: string;
  /** Tag the object with simple metadata (small ASCII values only). */
  metadata?: Record<string, string>;
  /**
   * Account scope (`common/scope.ts`'s `scopeId`) the object belongs to. When
   * given, the key is namespaced `acct/<scopeId>/…` so it can be authorized
   * later from the key alone — see `key-scope.ts`. Every new call site should
   * pass it; it is optional only because the pre-existing ones cannot all be
   * given a scope (a tenant uploading a payment proof passes the LANDLORD's).
   */
  scopeId?: number;
}

const DEFAULT_TTL = 60 * 15; // 15 minutes
const MAX_INLINE_BYTES = 25 * 1024 * 1024; // 25 MB hard ceiling per upload

/**
 * Thin wrapper around the MinIO bucket. MinIO is S3-compatible, so we use the
 * AWS SDK with `forcePathStyle: true`.
 *
 * Other modules should inject this service whenever they need to persist a
 * file (maintenance attachments, profile avatars, contract scans, ...) instead
 * of touching the SDK directly. That keeps bucket name, signing, and limits
 * in one place.
 */
@Injectable()
export class UploadsService {
  private readonly log = new Logger(UploadsService.name);
  private readonly endpoint = process.env.MINIO_ENDPOINT || "";
  private readonly region = process.env.MINIO_REGION || "us-east-1";
  private readonly bucket = process.env.MINIO_BUCKET || "";
  private readonly accessKey = process.env.MINIO_ACCESS_KEY || "";
  private readonly secretKey = process.env.MINIO_SECRET_KEY || "";
  private readonly publicUrlBase = (process.env.MINIO_PUBLIC_URL_BASE || "").replace(/\/+$/, "");
  private readonly defaultTtl = Number(process.env.MINIO_PRESIGN_TTL || DEFAULT_TTL);
  private _client: S3Client | null = null;

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.bucket && this.accessKey && this.secretKey);
  }

  bucketName(): string {
    return this.bucket;
  }

  private client(): S3Client {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        "Uploads are not configured. Set MINIO_ENDPOINT, MINIO_BUCKET, MINIO_ACCESS_KEY, MINIO_SECRET_KEY.",
      );
    }
    if (!this._client) {
      this._client = new S3Client({
        endpoint: this.endpoint,
        region: this.region,
        credentials: { accessKeyId: this.accessKey, secretAccessKey: this.secretKey },
        forcePathStyle: true,
      });
    }
    return this._client;
  }

  /**
   * Build an object key under an optional folder. Always lowercased extension,
   * slash-safe, and — when `opts.scopeId` is given — namespaced under
   * `acct/<scopeId>/`, which is what makes the key self-authorizing.
   *
   * The folder is sanitized rather than merely trimmed of slashes: it is
   * caller-supplied, and `../..` in it would otherwise reshape the account
   * prefix it is appended to.
   */
  buildKey(originalName: string, opts: UploadOptions = {}): string {
    const ext = extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, "");
    const base = opts.filename
      ? opts.filename.replace(/[^a-zA-Z0-9._-]/g, "_")
      : `${Date.now()}-${randomUUID()}${ext}`;
    const folder = opts.scopeId != null
      ? scopedFolder(opts.scopeId, opts.folder)
      : sanitizeFolder(opts.folder);
    return folder ? `${folder}/${base}` : base;
  }

  /**
   * Upload a buffer to MinIO and return the stored key + metadata. Callers are
   * responsible for persisting the returned `key` on the relevant DB row.
   */
  async upload(file: { buffer: Buffer; originalname: string; mimetype: string; size: number }, opts: UploadOptions = {}): Promise<UploadResult> {
    if (!file?.buffer || file.size <= 0) throw new BadRequestException("Empty file");
    if (file.size > MAX_INLINE_BYTES) {
      throw new BadRequestException(`الملف يتجاوز الحد الأقصى المسموح به (${Math.floor(MAX_INLINE_BYTES / 1024 / 1024)}MB)`);
    }

    const key = this.buildKey(file.originalname, opts);
    await this.client().send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || "application/octet-stream",
      Metadata: opts.metadata,
    }));

    return {
      key,
      bucket: this.bucket,
      size: file.size,
      contentType: file.mimetype || "application/octet-stream",
      originalName: file.originalname,
    };
  }

  /** Pre-signed GET URL — preferred way to expose a file to the browser. */
  async presignGet(key: string, ttlSeconds?: number): Promise<string> {
    if (!key) throw new BadRequestException("key is required");
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client(), cmd, { expiresIn: ttlSeconds ?? this.defaultTtl });
  }

  /** Read an object back into memory. For server-side post-processing (e.g.
   *  wrapping a stored invoice PDF as PDF/A-3), where a signed URL would mean
   *  the API making an HTTP round trip to itself. */
  async getObject(key: string): Promise<Buffer> {
    if (!key) throw new BadRequestException("key is required");
    const out = await this.client().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /** Pre-signed PUT URL — for direct-from-browser uploads if we need it later. */
  async presignPut(args: { key: string; contentType?: string; ttlSeconds?: number }): Promise<{ url: string; key: string; expiresIn: number }> {
    const ttl = args.ttlSeconds ?? this.defaultTtl;
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: args.key, ContentType: args.contentType });
    const url = await getSignedUrl(this.client(), cmd, { expiresIn: ttl });
    return { url, key: args.key, expiresIn: ttl };
  }

  async delete(key: string): Promise<void> {
    if (!key) throw new BadRequestException("key is required");
    await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Returns metadata for an object (or null when missing). */
  async stat(key: string): Promise<{ size: number; contentType: string; etag?: string } | null> {
    try {
      const out = await this.client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: Number(out.ContentLength || 0),
        contentType: out.ContentType || "application/octet-stream",
        etag: out.ETag,
      };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return null;
      this.log.error(`stat(${key}) failed: ${err?.message || err}`);
      throw err;
    }
  }

  /** Direct public URL (only meaningful when the bucket is public). Empty string when not configured. */
  publicUrl(key: string): string {
    if (!this.publicUrlBase) return "";
    return `${this.publicUrlBase}/${key}`;
  }
}
