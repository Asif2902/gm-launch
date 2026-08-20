import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";

import { saveTokenMeta, type TokenMeta } from "@/lib/metaApi";
import { useAuthedWrite } from "./SessionProvider";
import { SocialLinks } from "./SocialLinks";
import {
  TokenDetailsFields,
  emptyTokenDetails,
  type TokenDetailsDraft,
} from "./TokenDetailsFields";

/**
 * Description and links for a token, with an inline editor for its creator.
 *
 * Who may edit is decided server-side: the PUT is session-gated and the route reads the
 * token's `creator` from the launchpad before writing. This component only decides whether to
 * *show* the button — hiding it from everyone else is a courtesy, not the control.
 */
export function TokenDetailsPanel({
  token,
  symbol,
  creator,
  meta,
}: {
  token: string;
  symbol: string;
  creator: string;
  meta: TokenMeta | null | undefined;
}) {
  const { address, isConnected } = useAccount();
  const authedWrite = useAuthedWrite();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TokenDetailsDraft>(emptyTokenDetails);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreator =
    isConnected && address && address.toLowerCase() === creator.toLowerCase();

  const hasContent = Boolean(
    meta?.description || meta?.website || meta?.twitter || meta?.telegram || meta?.discord,
  );

  const startEditing = () => {
    setDraft({
      description: meta?.description ?? "",
      website: meta?.website ?? "",
      twitter: meta?.twitter ?? "",
      telegram: meta?.telegram ?? "",
      discord: meta?.discord ?? "",
      imageKey: null,
      imageUrl: meta?.imageUrl ?? null,
    });
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!address) return;
    setSaving(true);
    setError(null);

    try {
      await authedWrite((authorization) =>
        saveTokenMeta(token, authorization, {
          description: draft.description,
          website: draft.website,
          twitter: draft.twitter,
          telegram: draft.telegram,
          discord: draft.discord,
          ...(draft.imageKey ? { imageKey: draft.imageKey } : {}),
        }),
      );

      await queryClient.invalidateQueries({ queryKey: ["token-meta", token] });
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="card animate-fade-up p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-bold">Edit {symbol} details</h2>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-dim hover:text-white"
          >
            Cancel
          </button>
        </div>

        <TokenDetailsFields draft={draft} onChange={setDraft} disabled={saving} />

        {error && (
          <p className="mt-3 break-words rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[11px] text-down-light">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn-primary mt-4 w-full"
        >
          {saving ? "Saving…" : "Save details"}
        </button>
        <p className="mt-2 text-center text-[10px] text-dim">
          Saved with the session you opened when you connected. No gas, no transaction.
        </p>
      </div>
    );
  }

  if (!hasContent && !isCreator) return null;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">About</h2>
        {isCreator && (
          <button
            type="button"
            onClick={startEditing}
            className="btn-ghost btn-sm"
          >
            {hasContent ? "Edit" : "Add details"}
          </button>
        )}
      </div>

      {meta?.description ? (
        <p className="mt-2.5 whitespace-pre-line text-sm leading-relaxed text-muted">
          {meta.description}
        </p>
      ) : (
        <p className="mt-2.5 text-sm text-dim">
          {isCreator
            ? "No description yet. Add one so people know what they're buying."
            : "The creator hasn't added a description."}
        </p>
      )}

      {meta && <SocialLinks links={meta} showLabels className="mt-3" />}
    </div>
  );
}
