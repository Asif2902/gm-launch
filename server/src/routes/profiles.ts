import { Router } from "express";
import { isAddress } from "viem";

import { AuthError, requireAuth } from "../auth";
import {
  getProfile,
  getProfileByUsername,
  getProfilesBatch,
  isUsernameAvailable,
  upsertProfile,
} from "../db";
import { publicUrl } from "../storage";
import { SOCIAL_LIMITS, clampText, normaliseSocial, validateUsername } from "../socials";

export const profiles = Router();

/** Cap the batch so a caller can't ask for an unbounded IN (...) list. */
const MAX_BATCH = 100;

/** Resolves stored object keys to public URLs so the client never handles bucket paths. */
function serialise(profile: Awaited<ReturnType<typeof getProfile>>) {
  if (!profile) return null;
  return {
    ...profile,
    avatarUrl: publicUrl(profile.avatarKey),
    bannerUrl: publicUrl(profile.bannerKey),
  };
}

/**
 * Username lookup and availability check.
 *
 *   ?username=foo            -> the profile that owns it, or null
 *   ?username=foo&check=0x.. -> whether `0x..` may claim it
 *
 * Registered before `/:address` so the literal path wins over the parameter.
 */
profiles.get("/lookup", async (req, res) => {
  const raw = typeof req.query.username === "string" ? req.query.username : "";
  if (!raw) {
    res.status(400).json({ error: "username is required" });
    return;
  }

  let username: string;
  try {
    username = validateUsername(raw);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid username",
      available: false,
    });
    return;
  }

  const claimant = typeof req.query.check === "string" ? req.query.check : null;
  if (claimant) {
    res.json({ username, available: await isUsernameAvailable(username, claimant) });
    return;
  }

  const profile = await getProfileByUsername(username);
  res.json({ profile: profile ? serialise(profile) : null });
});

/**
 * Batch lookup for lists: `?addresses=0x..,0x..`.
 *
 * One query for a whole ticker or leaderboard rather than a request per row. Registered before
 * `/:address` so the literal path wins over the parameter.
 *
 * Public, like the single-profile route — a profile is public material by definition. The cap
 * stops a caller asking for an unbounded `IN (...)` list.
 */
profiles.get("/batch", async (req, res) => {
  const raw = typeof req.query.addresses === "string" ? req.query.addresses : "";

  const addresses = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value))
    .slice(0, MAX_BATCH);

  if (addresses.length === 0) {
    res.json({ profiles: {} });
    return;
  }

  const found = await getProfilesBatch(addresses);
  const out: Record<string, unknown> = {};
  for (const [address, profile] of found) {
    out[address] = serialise(profile);
  }

  res.json({ profiles: out });
});

profiles.get("/:address", async (req, res) => {
  const address = req.params.address;
  if (!isAddress(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const profile = await getProfile(address);
  res.json({ profile: profile ? serialise(profile) : null });
});

profiles.put("/:address", async (req, res) => {
  try {
    const address = req.params.address;
    if (!isAddress(address)) {
      res.status(400).json({ error: "Invalid address" });
      return;
    }

    const body = req.body ?? {};
    const signer = await requireAuth(req, { action: "update-profile" }, res);

    // Authentication only proves control of *some* address; it must be this one.
    if (signer !== address.toLowerCase()) {
      res.status(403).json({ error: "You can only edit your own profile" });
      return;
    }

    const input: Parameters<typeof upsertProfile>[1] = {};

    if (body.username !== undefined && body.username !== null && body.username !== "") {
      const username = validateUsername(String(body.username));
      if (!(await isUsernameAvailable(username, signer))) {
        res.status(409).json({ error: "That username is taken" });
        return;
      }
      input.username = username;
    }

    if (body.displayName !== undefined) {
      input.displayName = clampText(body.displayName, SOCIAL_LIMITS.displayName);
    }
    if (body.bio !== undefined) input.bio = clampText(body.bio, SOCIAL_LIMITS.bio);
    if (body.avatarKey !== undefined) input.avatarKey = body.avatarKey || null;
    if (body.bannerKey !== undefined) input.bannerKey = body.bannerKey || null;

    for (const platform of ["website", "twitter", "telegram", "discord", "github"] as const) {
      if (body[platform] !== undefined) {
        input[platform] = normaliseSocial(platform, body[platform]);
      }
    }

    const profile = await upsertProfile(signer, input);
    if (!profile) {
      res.status(503).json({ error: "Profile storage is not configured on this deployment" });
      return;
    }

    res.json({ profile: serialise(profile) });
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(400).json({
      error: error instanceof Error ? error.message : "Could not save profile",
    });
  }
});
