import { ImageUploader } from "./ImageUploader";
import { SocialIcon } from "./SocialIcons";
import { SOCIAL_LIMITS } from "@/lib/socials";
import type { UploadResult } from "@/lib/metaApi";

export interface TokenDetailsDraft {
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  imageKey: string | null;
  imageUrl: string | null;
}

export const emptyTokenDetails: TokenDetailsDraft = {
  description: "",
  website: "",
  twitter: "",
  telegram: "",
  discord: "",
  imageKey: null,
  imageUrl: null,
};

const SOCIAL_FIELDS = [
  { key: "website", platform: "website", placeholder: "yoursite.com" },
  { key: "twitter", platform: "twitter", placeholder: "@handle" },
  { key: "telegram", platform: "telegram", placeholder: "@channel" },
  { key: "discord", platform: "discord", placeholder: "discord.gg/invite" },
] as const;

/**
 * The optional, off-chain half of a token: picture, blurb and links.
 *
 * Deliberately separated from the on-chain fields in the UI as well as in storage. Name, ticker
 * and supply are immutable protocol state; everything here is editable by the creator and lives
 * in Turso, so the form says so rather than implying these are part of the token contract.
 *
 * Handles are accepted alongside full URLs — `@someone` is what people actually type — and
 * normalised server-side.
 */
export function TokenDetailsFields({
  draft,
  onChange,
  disabled = false,
}: {
  draft: TokenDetailsDraft;
  onChange: (next: TokenDetailsDraft) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof TokenDetailsDraft>(key: K, value: TokenDetailsDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const handleUpload = (result: UploadResult | null) => {
    onChange({
      ...draft,
      imageKey: result?.key ?? null,
      imageUrl: result?.url ?? null,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="sm:w-[168px] sm:shrink-0">
          <ImageUploader
            kind="token"
            value={draft.imageUrl}
            onUploaded={handleUpload}
            label="Logo"
            hint="Square works best"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="label">Description</span>
            <span
              className={`tnum text-[11px] ${
                draft.description.length > SOCIAL_LIMITS.description ? "text-down-light" : "text-dim"
              }`}
            >
              {draft.description.length}/{SOCIAL_LIMITS.description}
            </span>
          </div>
          <textarea
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
            disabled={disabled}
            rows={6}
            placeholder="What is this token? Keep it short — this is what people read before they buy."
            className="input resize-none leading-relaxed"
          />
        </div>
      </div>

      <div>
        <span className="label mb-2 block">Links</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {SOCIAL_FIELDS.map((field) => (
            <div key={field.key} className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">
                <SocialIcon platform={field.platform} className="h-3.5 w-3.5" />
              </span>
              <input
                value={draft[field.key]}
                onChange={(event) => set(field.key, event.target.value)}
                disabled={disabled}
                placeholder={field.placeholder}
                className="input py-2.5 pl-9 text-xs"
              />
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-dim">
          Optional, and editable later. Stored off-chain — the token contract itself has no
          metadata, no owner and no admin fields.
        </p>
      </div>
    </div>
  );
}
