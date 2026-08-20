import { useCallback, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { MAX_UPLOAD_BYTES, uploadImage, type UploadResult } from "@/lib/metaApi";
import { useAuthedWrite } from "./SessionProvider";

/**
 * Drag-and-drop image picker that uploads through `/api/upload`.
 *
 * The 5 MB cap is checked here for a fast, specific error — but it is enforced again on the
 * server, which is the actual control. The same is true of the type check: this only decides
 * what to bother uploading; the server sniffs magic bytes and re-encodes.
 *
 * After upload it reports the real before/after byte counts, because "we compress your image"
 * is the kind of claim that should be visible rather than asserted.
 */
export function ImageUploader({
  kind,
  value,
  onUploaded,
  label = "Image",
  hint,
  aspect = "square",
}: {
  kind: "token" | "avatar" | "banner";
  /** Currently selected image URL, if any. */
  value?: string | null;
  onUploaded: (result: UploadResult | null) => void;
  label?: string;
  hint?: string;
  aspect?: "square" | "wide";
}) {
  const { isConnected } = useAccount();
  const authedWrite = useAuthedWrite();

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<UploadResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`);
        return;
      }
      if (!isConnected) {
        setError("Connect your wallet first — uploads are authenticated.");
        return;
      }


      // Show the local file immediately; the compressed result replaces it when it lands.
      const localUrl = URL.createObjectURL(file);
      setPreview(localUrl);
      setBusy(true);

      try {
        // Uses the session opened at connect; only a lapsed one re-opens the wallet, once.
        const result = await authedWrite((token) => uploadImage(file, kind, token));
        setStats(result);
        setPreview(result.url);
        onUploaded(result);
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
        setPreview(null);
        onUploaded(null);
      } finally {
        setBusy(false);
        URL.revokeObjectURL(localUrl);
      }
    },
    [authedWrite, isConnected, kind, onUploaded],
  );

  const shown = preview ?? value ?? null;
  const box = aspect === "wide" ? "aspect-[3/1]" : "aspect-square max-w-[168px]";

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className="text-[10px] text-dim">WebP · max 5 MB</span>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={`group relative flex ${box} w-full cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed transition-all duration-200 ${
          dragging
            ? "border-brand bg-brand/10"
            : "border-line bg-canvas/60 hover:border-brand/50"
        }`}
      >
        {shown ? (
          <>
            {/* User content of unknown dimensions; a plain img is the honest element. */}
            <img src={shown} alt="" className="h-full w-full object-cover" />
            <div className="absolute inset-0 grid place-items-center bg-canvas/70 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="text-xs font-semibold">Replace</span>
            </div>
          </>
        ) : (
          <div className="px-4 py-6 text-center">
            <UploadGlyph />
            <p className="mt-2 text-xs font-semibold text-muted">
              {dragging ? "Drop it" : "Drag an image or click"}
            </p>
            {hint && <p className="mt-1 text-[10px] leading-relaxed text-dim">{hint}</p>}
          </div>
        )}

        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-canvas/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2">
              <span className="h-5 w-5 animate-spin-slow rounded-full border-2 border-brand border-t-transparent" />
              <span className="text-[10px] font-semibold text-muted">Compressing…</span>
            </div>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
      />

      {stats && !error && (
        <p className="tnum mt-2 text-[10px] leading-relaxed text-up-light">
          {formatBytes(stats.originalBytes)} → {formatBytes(stats.storedBytes)}
          {stats.savedPercent > 0 && ` · ${stats.savedPercent}% smaller`} · {stats.width}×
          {stats.height}
          {stats.mock && <span className="text-dim"> · stored inline (demo)</span>}
        </p>
      )}

      {error && <p className="mt-2 text-[11px] text-down-light">{error}</p>}

      {shown && !busy && (
        <button
          type="button"
          onClick={() => {
            setPreview(null);
            setStats(null);
            onUploaded(null);
          }}
          className="mt-2 text-[11px] text-dim transition-colors hover:text-down-light"
        >
          Remove
        </button>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function UploadGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mx-auto h-6 w-6 text-dim"
      aria-hidden
    >
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M3.5 15.5v2A2.5 2.5 0 0 0 6 20h12a2.5 2.5 0 0 0 2.5-2.5v-2" />
    </svg>
  );
}
