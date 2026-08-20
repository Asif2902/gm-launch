/**
 * The exact strings a wallet signs, for both the session sign-in and the legacy per-write path.
 *
 * ⚠️ Duplicated verbatim at `web/src/lib/authMessage.ts`. The client builds the message and the
 * server rebuilds it to verify the signature, so the two must stay byte identical — any drift
 * makes every signature fail to verify. Change both together.
 *
 * Neither of these is a transaction: they cost no gas, move nothing, and grant only the ability
 * to edit off-chain metadata the signing address already owns.
 */
export type AuthAction = "upload-image" | "update-profile" | "update-token";

/** Signatures older than this are rejected, so a captured one cannot be replayed indefinitely. */
export const AUTH_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The sign-in message, signed once when a wallet connects.
 *
 * It spells out the session it is opening — what the token may do and when it ends — because a
 * signature prompt is the only thing the user actually reads, and "sign this opaque blob" is how
 * people get drained. `nonce` makes each sign-in unique so one signature maps to one session
 * rather than being reusable text.
 *
 * Both bounds are stated because both are real: `Session Expires` is the hard deadline no amount
 * of activity can push back, and `Inactivity Timeout` is the shorter one that ends the session
 * early if it goes unused. Naming only the first would overstate how long the credential lives;
 * naming only the second would understate it.
 */
export function buildSignInMessage(input: {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  idleMs: number;
}): string {
  return [
    `${input.domain} wants you to sign in with your wallet.`,
    "",
    `Address: ${input.address.toLowerCase()}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date(input.issuedAt).toISOString()}`,
    `Session Expires: ${new Date(input.expiresAt).toISOString()}`,
    `Inactivity Timeout: ${formatDuration(input.idleMs)}`,
    "",
    "Signing proves you control this wallet and opens a session for editing your own profile",
    "and the details of tokens you created. The session ends at the time above, or sooner if you",
    "stop using it. It is not a transaction: it costs no gas, moves no funds, and gives no",
    "permission to spend anything.",
  ].join("\n");
}

/** Plain-language duration for the signature prompt: "12 hours", "45 minutes". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Legacy per-write message: one signature per off-chain write.
 *
 * Superseded by the session above and kept only so a client running older JavaScript — a stale
 * tab, a cached bundle — keeps working through a deploy. New code should sign in instead.
 */
export function buildAuthMessage(
  action: AuthAction,
  address: string,
  issuedAt: number,
  subject?: string,
): string {
  const lines = [
    "gm Launch",
    "",
    `Action: ${action}`,
    `Address: ${address.toLowerCase()}`,
  ];

  // Binds the signature to one token, so a signature for token A can't be replayed on token B.
  if (subject) lines.push(`Subject: ${subject.toLowerCase()}`);

  lines.push(
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    "",
    "Signing proves you control this wallet. It is not a transaction and moves no funds.",
  );

  return lines.join("\n");
}
