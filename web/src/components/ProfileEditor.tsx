import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useAccount } from "wagmi";

import {
  checkUsername,
  profileStorageAvailability,
  saveProfile,
  type StorageAvailability,
  type UsernameCheck,
  type UserProfile,
} from "@/lib/metaApi";
import { SOCIAL_LIMITS } from "@/lib/socials";
import { ImageUploader } from "./ImageUploader";
import { useAuthedWrite } from "./SessionProvider";
import { SocialIcon } from "./SocialIcons";

const SOCIAL_FIELDS = [
  { key: "website", platform: "website", placeholder: "yoursite.com" },
  { key: "twitter", platform: "twitter", placeholder: "@handle" },
  { key: "telegram", platform: "telegram", placeholder: "@handle" },
  { key: "github", platform: "github", placeholder: "@handle" },
] as const;

/**
 * Profile editor for the connected wallet.
 *
 * Username availability is checked as you type — debounced, and only after the format is
 * plausible — so a taken handle surfaces before the save rather than as a 409 afterwards. The
 * check is advisory; the server re-checks under the unique constraint, which is what actually
 * prevents two people claiming the same name.
 */
export function ProfileEditor({
  profile,
  onSaved,
  onCancel,
}: {
  profile: UserProfile | null;
  onSaved: (profile: UserProfile) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { address } = useAccount();
  const authedWrite = useAuthedWrite();
  const queryClient = useQueryClient();

  // Without storage there is nowhere to persist to. Say so up front rather than letting someone
  // fill in a form, save it, and receive a 503. `unknown` — the API being unreachable rather than
  // storage-less — is reported separately, because the two need different things from the reader:
  // one is a deployment to configure, the other is a service to wait for.
  const [storage, setStorage] = useState<StorageAvailability>("checking");
  useEffect(() => {
    void profileStorageAvailability().then(setStorage);
  }, []);

  const [username, setUsername] = useState(profile?.username ?? "");
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatarUrl ?? null);
  const [links, setLinks] = useState({
    website: profile?.website ?? "",
    twitter: profile?.twitter ?? "",
    telegram: profile?.telegram ?? "",
    github: profile?.github ?? "",
  });

  const [availability, setAvailability] = useState<
    { status: "idle" | "checking" } | UsernameCheck
  >({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unchanged = username.toLowerCase() === (profile?.username ?? "").toLowerCase();

  // Guards against out-of-order responses: with debounced typing a slow earlier request can land
  // after a faster later one and overwrite the result with a stale verdict.
  const checkSeq = useRef(0);

  useEffect(() => {
    if (!address || username.trim() === "" || unchanged) {
      setAvailability({ status: "idle" });
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setAvailability({ status: "idle" });
      return;
    }

    setAvailability({ status: "checking" });
    const seq = ++checkSeq.current;

    const timer = setTimeout(async () => {
      const result = await checkUsername(username, address);
      if (seq === checkSeq.current) setAvailability(result);
    }, 400);

    return () => clearTimeout(timer);
  }, [username, address, unchanged]);

  // Only a definite "taken" blocks saving. If the check errored we let the attempt through — the
  // server re-checks under the unique constraint, which is the real guard.
  const blocked = availability.status === "taken";

  const save = async () => {
    if (!address) return;
    setSaving(true);
    setError(null);

    try {
      const saved = await authedWrite((token) =>
        saveProfile(address, token, {
          username: username.trim() || undefined,
          displayName,
          bio,
          ...(avatarKey ? { avatarKey } : {}),
          ...links,
        }),
      );

      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      await onSaved(saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card animate-fade-up p-5">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-bold">Edit profile</h2>
        <button type="button" onClick={onCancel} className="text-xs text-dim hover:text-white">
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="sm:w-[168px] sm:shrink-0">
          <ImageUploader
            kind="avatar"
            value={avatarUrl}
            onUploaded={(result) => {
              setAvatarKey(result?.key ?? null);
              setAvatarUrl(result?.url ?? null);
            }}
            label="Avatar"
          />
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="label">Username</span>
              <span className="text-[11px]">
                {availability.status === "checking" && <span className="text-dim">checking…</span>}
                {availability.status === "free" && (
                  <span className="text-up-light">available</span>
                )}
                {availability.status === "taken" && (
                  <span className="text-down-light">taken</span>
                )}
                {availability.status === "invalid" && (
                  <span className="text-down-light">{availability.message}</span>
                )}
                {availability.status === "error" && (
                  <span className="text-warn" title={availability.message}>
                    couldn&apos;t check
                  </span>
                )}
              </span>
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dim">
                @
              </span>
              <input
                value={username}
                onChange={(event) =>
                  setUsername(event.target.value.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase())
                }
                placeholder="degenmaxi"
                maxLength={SOCIAL_LIMITS.username}
                className="input pl-7"
              />
            </div>
            <p className="mt-1.5 text-[10px] text-dim">
              Your profile lives at /u/{username || "username"}
            </p>
          </div>

          <div>
            <span className="label mb-2 block">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="How you want to be shown"
              maxLength={SOCIAL_LIMITS.displayName}
              className="input"
            />
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="label">Bio</span>
              <span className="tnum text-[11px] text-dim">
                {bio.length}/{SOCIAL_LIMITS.bio}
              </span>
            </div>
            <textarea
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              rows={3}
              maxLength={SOCIAL_LIMITS.bio}
              placeholder="A line about you"
              className="input resize-none leading-relaxed"
            />
          </div>
        </div>
      </div>

      <div className="mt-5">
        <span className="label mb-2 block">Links</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {SOCIAL_FIELDS.map((field) => (
            <div key={field.key} className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim">
                <SocialIcon platform={field.platform} className="h-3.5 w-3.5" />
              </span>
              <input
                value={links[field.key]}
                onChange={(event) =>
                  setLinks({ ...links, [field.key]: event.target.value })
                }
                placeholder={field.placeholder}
                className="input py-2.5 pl-9 text-xs"
              />
            </div>
          ))}
        </div>
      </div>

      {storage === "unconfigured" && (
        <p className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          Profile storage isn&apos;t configured on this deployment, so changes can&apos;t be
          saved. Set <code className="font-mono">TURSO_URL</code> and{" "}
          <code className="font-mono">TURSO_AUTH_TOKEN</code>, then restart.
        </p>
      )}

      {storage === "unreachable" && (
        <p className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          Can&apos;t reach the profile API right now, so changes can&apos;t be saved. Nothing is
          lost — reload once it&apos;s back.
        </p>
      )}

      {error && (
        <p className="mt-4 break-words rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[11px] text-down-light">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving || blocked || storage === "unconfigured" || storage === "unreachable"}
        className="btn-primary mt-5 w-full"
      >
        {saving ? "Saving…" : "Save profile"}
      </button>
      <p className="mt-2 text-center text-[10px] text-dim">
        Saved with the session you opened when you connected. No gas, no transaction.
      </p>
    </div>
  );
}
