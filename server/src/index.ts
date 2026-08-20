import cors from "cors";
import express from "express";

import { AUTH_DOMAIN, CORS_ORIGIN, FACTORY_ADDRESS, PORT } from "./config";
import { assertEnvSane, storageConfigured, storageStatus } from "./env";
import { auth } from "./routes/auth";
import { ethPrice } from "./routes/ethPrice";
import { profiles } from "./routes/profiles";
import { tokens } from "./routes/tokens";
import { upload } from "./routes/upload";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./session";

/**
 * Off-chain metadata API.
 *
 * Exists as its own process because everything it does needs credentials or native code that
 * cannot live in a browser bundle: Turso and R2 keys, `sharp` image re-encoding, and wallet
 * signature verification. The Vite frontend proxies `/api` here in development and talks to it
 * by URL in production.
 *
 * Nothing on-chain depends on this service. Prices, reserves, supply, holdings and migration
 * state all come from the contracts and the event stream — if this process is down, the app
 * still trades; it just loses pictures, descriptions and profiles.
 */
const app = express();

app.use(
  cors({
    origin: CORS_ORIGIN,
    // Without this a cross-origin client cannot read the rotated session token, and every
    // sliding renewal would be silently dropped on the way back.
    exposedHeaders: ["X-Session-Token", "X-Session-Expires"],
  }),
);
// JSON body parsing must not apply to the upload route: multer needs the raw multipart stream.
app.use((req, res, next) =>
  req.path.startsWith("/api/upload") ? next() : express.json({ limit: "256kb" })(req, res, next),
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, factory: FACTORY_ADDRESS });
});

app.get("/api/storage/status", (_req, res) => {
  let envError: string | null = null;
  try {
    assertEnvSane();
  } catch (error) {
    envError = error instanceof Error ? error.message : "Invalid storage configuration";
  }

  // Redacted: hostnames and bucket name only, never a credential.
  res.json({ configured: storageConfigured && !envError, envError, ...storageStatus() });
});

app.use("/api/auth", auth);
app.use("/api/upload", upload);
app.use("/api/profiles", profiles);
app.use("/api/tokens", tokens);
app.use("/api/eth-price", ethPrice);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

app.listen(PORT, () => {
  console.log(`\nPumper API on http://localhost:${PORT}`);
  console.log(`  storage: ${storageConfigured ? "configured" : "not configured (demo fallbacks)"}`);
  console.log(`  factory: ${FACTORY_ADDRESS}\n`);
});
