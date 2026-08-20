import { Router } from "express";
import { randomBytes } from "node:crypto";
import { isAddress } from "viem";

import { AuthError, createSession } from "../auth";
import { AUTH_DOMAIN } from "../config";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  bearerToken,
  readSession,
  renewSession,
} from "../session";

/**
 * Sign in with a wallet: one signature, one session.
 *
 * The server hands out the parameters rather than accepting whatever the client proposes. The
 * domain and the session length are policy, and policy that the caller can set is not policy —
 * a client could otherwise mint itself a message naming any domain and a week-long session.
 */
export const auth = Router();

auth.get("/params", (req, res) => {
  const address = String(req.query.address ?? "");
  if (!isAddress(address)) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const issuedAt = Date.now();

  res.json({
    domain: AUTH_DOMAIN,
    address: address.toLowerCase(),
    nonce: randomBytes(16).toString("base64url"),
    issuedAt,
    // The signed message names the *hard cap*, since that is the outer bound of what signing
    // authorises. The idle timeout only ever shortens the session, so stating it separately keeps
    // the prompt accurate in both directions.
    expiresAt: issuedAt + SESSION_ABSOLUTE_MS,
    idleMs: SESSION_IDLE_MS,
    absoluteMs: SESSION_ABSOLUTE_MS,
  });
});

auth.post("/session", async (req, res) => {
  try {
    const body = req.body ?? {};

    const session = await createSession({
      // Never from the body: the message the signature covers has to name *this* server.
      domain: AUTH_DOMAIN,
      address: String(body.address ?? ""),
      nonce: String(body.nonce ?? ""),
      issuedAt: Number(body.issuedAt ?? 0),
      expiresAt: Number(body.expiresAt ?? 0),
      signature: String(body.signature ?? ""),
    });

    res.json({
      token: session.token,
      address: session.address,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: "Could not open a session" });
  }
});

/** Lets a client with a stored token check it is still good before showing itself as signed in. */
auth.get("/session", (req, res) => {
  const session = readSession(bearerToken(req.headers.authorization));
  if (!session) {
    res.status(401).json({ error: "No active session" });
    return;
  }
  res.json({
    address: session.address,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  });
});

/**
 * Slides a live session forward, no signature required.
 *
 * Reads are unauthenticated on this API, so a session would otherwise only ever be renewed by a
 * write — someone could browse for hours and still be asked to sign the moment they finally edit
 * something. An open tab calls this instead.
 *
 * It grants nothing new: renewal requires a currently valid token, and the hard cap from the
 * original signature is unmoved. A closed tab stops calling it and the session idles out, which
 * is exactly the behaviour that makes a long idle window safe to offer.
 */
auth.post("/refresh", (req, res) => {
  const session = readSession(bearerToken(req.headers.authorization));
  if (!session) {
    res.status(401).json({ error: "Session expired — please sign in again" });
    return;
  }

  const renewed = renewSession(session);
  res.json({
    token: renewed.token,
    address: renewed.address,
    issuedAt: renewed.issuedAt,
    expiresAt: renewed.expiresAt,
    absoluteExpiresAt: renewed.absoluteExpiresAt,
  });
});
