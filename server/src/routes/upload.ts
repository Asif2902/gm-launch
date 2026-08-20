import { Router } from "express";
import multer from "multer";
import sharp from "sharp";

import { AuthError, requireAuth } from "../auth";
import { recentUploadCount, recordImage } from "../db";
import { storageConfigured } from "../env";
import {
  MAX_UPLOAD_BYTES,
  UploadError,
  processAndUpload,
  sniffMime,
  type ImageKind,
} from "../storage";

export const upload = Router();

const KINDS = new Set<ImageKind>(["token", "avatar", "banner"]);

/** Uploads per address per hour. Storage and bandwidth cost money even when writes are signed. */
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 3600;

/**
 * In-memory multipart parsing with a hard byte ceiling.
 *
 * multer enforces `fileSize` while streaming, so an oversized upload is aborted mid-transfer
 * rather than buffered in full and rejected afterwards — the point of the limit is to never hold
 * the bytes at all.
 */
const parse = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

upload.post("/", (req, res) => {
  parse.single("file")(req, res, async (parseError) => {
    try {
      if (parseError) {
        const code = (parseError as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "Image exceeds the 5 MB limit", limitBytes: MAX_UPLOAD_BYTES });
          return;
        }
        res.status(400).json({ error: "Could not read the upload" });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No file provided" });
        return;
      }

      const kind = String(req.body?.kind ?? "token") as ImageKind;
      if (!KINDS.has(kind)) {
        res.status(400).json({ error: "Invalid image kind" });
        return;
      }

      // Runs after multer, so the legacy fallback can still read its fields out of the parsed
      // multipart body.
      const owner = await requireAuth(req, { action: "upload-image" }, res);

      if (storageConfigured) {
        const uploads = await recentUploadCount(owner, RATE_WINDOW_SECONDS);
        if (uploads >= RATE_LIMIT) {
          res.status(429).json({ error: "Too many uploads — try again later" });
          return;
        }

        const processed = await processAndUpload(file.buffer, kind, owner);

        await recordImage({
          key: processed.key,
          thumbKey: processed.thumbKey,
          owner,
          kind,
          mime: processed.mime,
          width: processed.width,
          height: processed.height,
          originalBytes: processed.originalBytes,
          storedBytes: processed.storedBytes,
          createdAt: Math.floor(Date.now() / 1000),
        });

        res.json({
          key: processed.key,
          thumbKey: processed.thumbKey,
          url: processed.url,
          thumbUrl: processed.thumbUrl,
          width: processed.width,
          height: processed.height,
          originalBytes: processed.originalBytes,
          storedBytes: processed.storedBytes,
          savedPercent: savedPercent(processed.originalBytes, processed.storedBytes),
          mock: false,
        });
        return;
      }

      // No bucket configured: still run the real compression so the pipeline is exercised and
      // the reported before/after numbers are genuine, then hand back an inline data URL.
      res.json(await compressOnly(file.buffer, kind));
    } catch (error) {
      if (error instanceof AuthError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof UploadError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error("[upload] unexpected failure", error);
      res.status(500).json({ error: "Upload failed" });
    }
  });
});

/** Compression without storage — used when R2/Turso are unconfigured. */
async function compressOnly(buffer: Buffer, kind: ImageKind) {
  const sniffed = sniffMime(buffer);
  if (!sniffed) throw new UploadError("Unsupported image format", 415);

  const maxEdge = kind === "banner" ? 1280 : 512;

  const full = await sharp(buffer, { limitInputPixels: 50_000_000, animated: false })
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  const thumb = await sharp(buffer, { limitInputPixels: 50_000_000, animated: false })
    .rotate()
    .resize(128, 128, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 74, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  // Keep the inline payload sane: prefer the full image, fall back to the thumbnail.
  const inline = full.data.length <= 120_000 ? full : thumb;

  return {
    key: null,
    thumbKey: null,
    url: `data:image/webp;base64,${inline.data.toString("base64")}`,
    thumbUrl: `data:image/webp;base64,${thumb.data.toString("base64")}`,
    width: full.info.width,
    height: full.info.height,
    originalBytes: buffer.length,
    storedBytes: full.data.length + thumb.data.length,
    savedPercent: savedPercent(buffer.length, full.data.length + thumb.data.length),
    mock: true,
  };
}

function savedPercent(before: number, after: number): number {
  if (before === 0) return 0;
  return Math.max(0, Math.round((1 - after / before) * 100));
}
