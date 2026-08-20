import { Router } from "express";
import { isAddress } from "viem";

import { AuthError, getTokenCreator, requireAuth } from "../auth";
import { getTokenMetadata, getTokenMetadataBatch, upsertTokenMetadata } from "../db";
import { publicUrl } from "../storage";
import { SOCIAL_LIMITS, clampText, normaliseSocial } from "../socials";

export const tokens = Router();

/** Cap the batch so a caller can't ask for an unbounded IN (...) list. */
const MAX_BATCH = 100;

function serialise(metadata: Awaited<ReturnType<typeof getTokenMetadata>>) {
  if (!metadata) return null;
  return {
    ...metadata,
    imageUrl: publicUrl(metadata.imageKey),
    bannerUrl: publicUrl(metadata.bannerKey),
  };
}

/**
 * Batch metadata lookup for the discover feed: `?addresses=0x..,0x..`.
 * One query for the whole page rather than a request per card.
 *
 * Registered before `/:address` so the literal path wins over the parameter.
 */
tokens.get("/metadata", async (req, res) => {
  const raw = typeof req.query.addresses === "string" ? req.query.addresses : "";

  const addresses = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value))
    .slice(0, MAX_BATCH);

  if (addresses.length === 0) {
    res.json({ metadata: {} });
    return;
  }

  const found = await getTokenMetadataBatch(addresses);
  const metadata: Record<string, unknown> = {};
  for (const [address, entry] of found) {
    metadata[address] = serialise(entry);
  }

  res.json({ metadata });
});

tokens.get("/:address/metadata", async (req, res) => {
  const address = req.params.address;
  if (!isAddress(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }
  res.json({ metadata: serialise(await getTokenMetadata(address)) });
});

tokens.put("/:address/metadata", async (req, res) => {
  try {
    const address = req.params.address;
    if (!isAddress(address)) {
      res.status(400).json({ error: "Invalid address" });
      return;
    }

    const body = req.body ?? {};

    // On the legacy per-write path, `subject` binds the signature to this token so one collected
    // for another token cannot be replayed here. A session needs no such binding: it authorises
    // the address, and the creator check below decides what that address may touch.
    const signer = await requireAuth(req, { action: "update-token", subject: address }, res);

    // The launchpad is the authority on who created a token — not the request body.
    const creator = await getTokenCreator(address);
    if (!creator) {
      res.status(404).json({ error: "Not a launchpad token, or the chain is unreachable" });
      return;
    }
    if (creator !== signer) {
      res.status(403).json({ error: "Only the token's creator can edit its details" });
      return;
    }

    const input: Parameters<typeof upsertTokenMetadata>[2] = {};

    if (body.description !== undefined) {
      input.description = clampText(body.description, SOCIAL_LIMITS.description);
    }
    if (body.imageKey !== undefined) input.imageKey = body.imageKey || null;
    if (body.bannerKey !== undefined) input.bannerKey = body.bannerKey || null;

    for (const platform of ["website", "twitter", "telegram", "discord"] as const) {
      if (body[platform] !== undefined) {
        input[platform] = normaliseSocial(platform, body[platform]);
      }
    }

    const metadata = await upsertTokenMetadata(address, creator, input);
    if (!metadata) {
      res.status(503).json({ error: "Metadata storage is not configured on this deployment" });
      return;
    }

    res.json({ metadata: serialise(metadata) });
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(400).json({
      error: error instanceof Error ? error.message : "Could not save token details",
    });
  }
});
