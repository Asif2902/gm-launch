/**
 * Fills the subgraph manifest from a contracts deployment record.
 *
 *   node scripts/sync-deployment.js [network]     # default: baseSepolia
 *
 * Reads contracts/deployments/<network>.json and writes the factory address + deployment block
 * into both subgraph.yaml and networks.json. Hand-editing those two in sync is exactly the kind
 * of step that gets forgotten, and the failure mode — a subgraph that indexes from block 0 of
 * the wrong address and simply returns nothing — is slow to diagnose.
 */
const fs = require("fs");
const path = require("path");

const NETWORKS = {
  baseSepolia: "base-sepolia",
  base: "base",
  hardhat: "base-sepolia", // local record, kept for shape checks only
};

const network = process.argv[2] || "baseSepolia";
const graphNetwork = NETWORKS[network];

if (!graphNetwork) {
  console.error(`Unknown network "${network}". Known: ${Object.keys(NETWORKS).join(", ")}`);
  process.exit(1);
}

const recordPath = path.join(
  __dirname,
  "..",
  "..",
  "contracts",
  "deployments",
  `${network}.json`,
);

if (!fs.existsSync(recordPath)) {
  console.error(`No deployment record at ${recordPath}`);
  console.error(`Deploy first:  cd contracts && npm run deploy:${network}`);
  process.exit(1);
}

const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
const address = record.contracts?.PumperFactory;
const startBlock = record.deploymentBlock;

if (!address || startBlock === undefined) {
  console.error("Deployment record is missing contracts.PumperFactory or deploymentBlock");
  process.exit(1);
}

// --- subgraph.yaml ---------------------------------------------------------------------------
const manifestPath = path.join(__dirname, "..", "subgraph.yaml");
let manifest = fs.readFileSync(manifestPath, "utf8");

manifest = manifest.replace(/address:\s*"0x[0-9a-fA-F]{40}"/, `address: "${address}"`);
manifest = manifest.replace(/startBlock:\s*\d+/, `startBlock: ${startBlock}`);
manifest = manifest.replace(/network:\s*[a-z-]+/g, `network: ${graphNetwork}`);

fs.writeFileSync(manifestPath, manifest);

// --- networks.json ---------------------------------------------------------------------------
const networksPath = path.join(__dirname, "..", "networks.json");
const networks = fs.existsSync(networksPath)
  ? JSON.parse(fs.readFileSync(networksPath, "utf8"))
  : {};

networks[graphNetwork] = { PumperFactory: { address, startBlock } };
fs.writeFileSync(networksPath, `${JSON.stringify(networks, null, 2)}\n`);

console.log("Subgraph synced to deployment:");
console.log(`  network     ${graphNetwork}`);
console.log(`  address     ${address}`);
console.log(`  startBlock  ${startBlock}`);
console.log("\nNext:  npm run build && npm run deploy");
