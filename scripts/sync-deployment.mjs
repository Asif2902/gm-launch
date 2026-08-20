#!/usr/bin/env node
/**
 * Propagates one deployment across every package.
 *
 *   node scripts/sync-deployment.mjs [network]      # default: base
 *
 * A deployment produces three facts — factory address, deployment block, chain id — that every
 * other package needs, each in a different format. Copying them by hand is the step that gets
 * half-done, and the failure is quiet: an indexer starting from the wrong block just reports
 * "0 tokens", and a frontend pointed at a stale address renders an empty feed. So this reads
 * contracts/deployments/<network>.json and writes:
 *
 *   indexer/.env          FACTORY_ADDRESS, START_BLOCK, CHAIN_ID, RPC_URL
 *   server/.env           FACTORY_ADDRESS, CHAIN_ID, RPC_URL
 *   web/.env.local        VITE_FACTORY_ADDRESS, VITE_CHAIN_ID, ...
 *   subgraph/subgraph.yaml + networks.json
 *   contracts/abis/       re-exported so every consumer decodes the same ABI
 *
 * Existing values in the env files are preserved — only the deployment-derived keys are
 * rewritten, so secrets and local overrides survive.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = process.argv[2] || "base";

const EXPLORERS = {
  baseSepolia: "https://sepolia.basescan.org",
  base: "https://basescan.org",
};
const RPCS = {
  baseSepolia: "https://sepolia.base.org",
  base: "https://mainnet.base.org",
};

// ---- read the deployment ----------------------------------------------------------------------

const recordPath = join(root, "contracts", "deployments", `${network}.json`);
if (!existsSync(recordPath)) {
  console.error(`No deployment record at ${recordPath}`);
  console.error(`Deploy first:  cd contracts && npm run deploy:${network}`);
  process.exit(1);
}

const record = JSON.parse(readFileSync(recordPath, "utf8"));
const factory = record.contracts?.PumperFactory;
const startBlock = record.deploymentBlock;
const chainId = record.chainId;

if (!factory || startBlock === undefined || !chainId) {
  console.error("Deployment record is incomplete (need contracts.PumperFactory, deploymentBlock, chainId)");
  process.exit(1);
}

console.log(`\nSyncing ${network} deployment across packages`);
console.log(`  factory     ${factory}`);
console.log(`  startBlock  ${startBlock}`);
console.log(`  chainId     ${chainId}\n`);

// ---- env file helpers ---------------------------------------------------------------------------

/** Rewrites only the given keys, leaving every other line (and any secrets) untouched. */
function patchEnv(filePath, updates, templatePath) {
  let lines = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  } else if (templatePath && existsSync(templatePath)) {
    lines = readFileSync(templatePath, "utf8").split(/\r?\n/);
    console.log(`  created ${short(filePath)} from ${short(templatePath)}`);
  }

  const remaining = new Map(Object.entries(updates));

  const patched = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  // Any key the file didn't already have gets appended.
  if (remaining.size > 0) {
    if (patched.length > 0 && patched[patched.length - 1].trim() !== "") patched.push("");
    for (const [key, value] of remaining) patched.push(`${key}=${value}`);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${patched.join("\n").replace(/\n+$/, "")}\n`);
  console.log(`  wrote   ${short(filePath)}`);
}

const short = (p) => p.replace(root, "").replace(/^[\\/]/, "").replace(/\\/g, "/");

// ---- indexer -------------------------------------------------------------------------------------

patchEnv(
  join(root, "indexer", ".env"),
  {
    CHAIN_ID: chainId,
    RPC_URL: RPCS[network] ?? RPCS.base,
    FACTORY_ADDRESS: factory,
    START_BLOCK: startBlock,
  },
  join(root, "indexer", ".env.example"),
);

// ---- server --------------------------------------------------------------------------------------

// The API verifies signatures against the launchpad (it reads a token's `creator` before letting
// anyone edit its metadata), so it needs the same address the frontend does.
patchEnv(
  join(root, "server", ".env"),
  {
    CHAIN_ID: chainId,
    RPC_URL: RPCS[network] ?? RPCS.base,
    FACTORY_ADDRESS: factory,
  },
  join(root, "server", ".env.example"),
);

// ---- web -----------------------------------------------------------------------------------------

patchEnv(
  join(root, "web", ".env.local"),
  {
    VITE_FACTORY_ADDRESS: factory,
    VITE_CHAIN_ID: chainId,
    VITE_RPC_URL: RPCS[network] ?? RPCS.base,
    VITE_EXPLORER_URL: EXPLORERS[network] ?? EXPLORERS.base,
    // A real deployment exists now, so stop serving the simulation by default.
    VITE_DEMO_MODE: "false",
  },
  join(root, "web", ".env.example"),
);

// ---- subgraph ------------------------------------------------------------------------------------

try {
  execFileSync("node", [join("scripts", "sync-deployment.js"), network], {
    cwd: join(root, "subgraph"),
    stdio: "pipe",
  });
  console.log("  wrote   subgraph/subgraph.yaml, subgraph/networks.json");
} catch (error) {
  console.log(`  SKIP    subgraph — ${error.message.split("\n")[0]}`);
}

// ---- ABIs ----------------------------------------------------------------------------------------

const abiDir = join(root, "contracts", "abis");
if (existsSync(join(abiDir, "PumperFactory.json"))) {
  console.log("  ok      contracts/abis (already generated)");
} else {
  console.log("  SKIP    contracts/abis — run `cd contracts && npm run abis`");
}

console.log(`
Next:
  cd indexer   && npm run migrate && npm run dev
  cd web       && npm run dev
  cd subgraph  && npm run build && npm run deploy
`);
