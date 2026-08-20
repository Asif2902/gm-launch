import * as fs from "fs";
import * as path from "path";

/**
 * Copies the ABIs every downstream consumer needs into `contracts/abis/`, which the indexer,
 * the subgraph and the frontend all read from. Keeping one generated copy means an ABI change
 * can never silently desync the three of them.
 */
const ARTIFACTS: Array<{ name: string; artifactPath: string }> = [
  { name: "PumperFactory", artifactPath: "contracts/PumperFactory.sol/PumperFactory.json" },
  { name: "PumperToken", artifactPath: "contracts/PumperToken.sol/PumperToken.json" },
  {
    name: "UniswapV2Migrator",
    artifactPath: "contracts/UniswapV2Migrator.sol/UniswapV2Migrator.json",
  },
];

export function exportAbis(): void {
  const artifactsRoot = path.join(__dirname, "..", "artifacts");
  const outputDir = path.join(__dirname, "..", "abis");
  fs.mkdirSync(outputDir, { recursive: true });

  const index: Record<string, unknown> = {};

  for (const { name, artifactPath } of ARTIFACTS) {
    const full = path.join(artifactsRoot, artifactPath);
    if (!fs.existsSync(full)) {
      throw new Error(`Artifact not found: ${full}. Run \`npm run build\` first.`);
    }
    const artifact = JSON.parse(fs.readFileSync(full, "utf8"));
    fs.writeFileSync(
      path.join(outputDir, `${name}.json`),
      `${JSON.stringify(artifact.abi, null, 2)}\n`,
    );
    index[name] = artifact.abi;
    console.log(`  ABI exported: abis/${name}.json`);
  }

  // Single bundle for consumers that prefer one import.
  fs.writeFileSync(path.join(outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  // Event-signature reference — handy when writing raw log filters in any language.
  const factoryAbi = index.PumperFactory as any[];
  const events = factoryAbi
    .filter((entry) => entry.type === "event")
    .map((entry) => {
      const inputs = entry.inputs.map((i: any) => i.type).join(",");
      return {
        name: entry.name,
        signature: `${entry.name}(${inputs})`,
        indexed: entry.inputs.filter((i: any) => i.indexed).map((i: any) => i.name),
      };
    });
  fs.writeFileSync(
    path.join(outputDir, "events.json"),
    `${JSON.stringify(events, null, 2)}\n`,
  );
  console.log(`  Event reference exported: abis/events.json (${events.length} events)`);
}

if (require.main === module) {
  console.log("Exporting ABIs...");
  exportAbis();
}
