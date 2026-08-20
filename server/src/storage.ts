import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp, { type Metadata, type Sharp } from "sharp";

import { r2 } from "./env";

/**
 * Image ingest: validate → re-encode → store on R2.
 *
 * Every uploaded byte is **re-encoded through sharp** rather than passed through. That is the
 * point of this module and it does three jobs at once:
 *
 *   1. **Size.** Phone photos arrive at 3–8 MB; a 512px WebP of the same image is 20–60 KB.
 *      Serving a wall of token avatars is otherwise brutal on mobile data.
 *   2. **Safety.** Re-encoding strips EXIF (including GPS coordinates people don't realise are
 *      in their camera roll) and discards anything that isn't decodable pixel data — a polyglot
 *      file with script appended, an SVG carrying JavaScript, a zip-bomb PNG. What lands in the
 *      bucket is bytes sharp itself produced.
 *   3. **Uniformity.** One format and one bounded dimension, so the UI never has to reason
 *      about a 9000px TIFF.
 *
 * The 5 MB cap is enforced on the raw upload *before* decoding, so a decompression bomb is
 * rejected on byte count rather than after sharp expands it in memory.
 */

/** Hard ceiling on the raw upload. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Longest edge of the stored image. Enough for a retina avatar, small enough to stay cheap. */
const MAX_DIMENSION = 512;
const THUMB_DIMENSION = 128;

/** Lossy on purpose — quality 82 WebP is visually indistinguishable here at a fraction of PNG. */
const WEBP_QUALITY = 82;
const THUMB_QUALITY = 74;

/**
 * Guarding sharp's decoder. Beyond the byte cap, refuse images whose *pixel* count is absurd:
 * a 30 000 × 30 000 PNG can compress to well under 5 MB and still exhaust memory on decode.
 */
const MAX_INPUT_PIXELS = 50_000_000; // 50 MP

export const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

let s3: S3Client | null = null;

function getS3(): S3Client {
  if (!r2) throw new UploadError("Object storage is not configured", 503);
  if (!s3) {
    s3 = new S3Client({
      region: "auto",
      endpoint: r2.endpoint,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });
  }
  return s3;
}

/**
 * Sniffs the real format from magic bytes.
 *
 * The browser-supplied `Content-Type` on a multipart part is attacker-controlled, so it is used
 * for nothing. This only decides whether to hand the buffer to sharp at all; sharp then does the
 * authoritative parse.
 */
export function sniffMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // ISO-BMFF container: AVIF/HEIF carry the brand in the ftyp box.
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
  }
  return null;
}

export interface ProcessedImage {
  key: string;
  thumbKey: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  originalBytes: number;
  storedBytes: number;
}

export type ImageKind = "token" | "avatar" | "banner";

/**
 * Validates, compresses and uploads an image.
 * @param owner Lowercased address the upload is attributed to; scopes the object key.
 */
export async function processAndUpload(
  input: Buffer,
  kind: ImageKind,
  owner: string,
): Promise<ProcessedImage> {
  if (input.length === 0) throw new UploadError("Empty file", 400);
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `Image is ${(input.length / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`,
      413,
    );
  }

  const sniffed = sniffMime(input);
  if (!sniffed || !ACCEPTED_MIME.has(sniffed)) {
    throw new UploadError("Unsupported image format. Use JPEG, PNG, WebP, GIF or AVIF.", 415);
  }

  // Banners are wide, so they get a longer edge; avatars and token marks are square-ish.
  const maxEdge = kind === "banner" ? 1280 : MAX_DIMENSION;

  let pipeline: Sharp;
  let metadata: Metadata;
  try {
    pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    metadata = await pipeline.metadata();
  } catch {
    throw new UploadError("Could not decode that image", 400);
  }

  if (!metadata.width || !metadata.height) {
    throw new UploadError("Could not read image dimensions", 400);
  }

  const encode = (size: number, quality: number) =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate() // honour EXIF orientation before the tag is stripped
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });

  const [full, thumb] = await Promise.all([
    encode(maxEdge, WEBP_QUALITY),
    encode(THUMB_DIMENSION, THUMB_QUALITY),
  ]);

  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  const base = `${kind}/${owner}/${stamp}-${random}`;
  const key = `${base}.webp`;
  const thumbKey = `${base}-thumb.webp`;

  const client = getS3();
  const bucket = r2!.bucket;

  await Promise.all([
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: full.data,
        ContentType: "image/webp",
        // Content is immutable: the key embeds a timestamp and nonce, so it is never rewritten.
        CacheControl: "public, max-age=31536000, immutable",
      }),
    ),
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: thumbKey,
        Body: thumb.data,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    ),
  ]);

  return {
    key,
    thumbKey,
    url: publicUrl(key)!,
    thumbUrl: publicUrl(thumbKey)!,
    width: full.info.width,
    height: full.info.height,
    mime: "image/webp",
    originalBytes: input.length,
    storedBytes: full.data.length + thumb.data.length,
  };
}

/** Resolves a stored object key to its public URL. */
export function publicUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  // Already absolute (mock data seeds full URLs).
  if (/^https?:\/\//i.test(key)) return key;
  if (!r2) return null;
  return `${r2.publicBaseUrl}/${key}`;
}
