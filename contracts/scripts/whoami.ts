import { ethers, network } from "hardhat";

/**
 * Pre-flight check for a deployment: who am I, on what chain, with how much gas money.
 *
 *   npx hardhat run scripts/whoami.ts --network baseSepolia
 *
 * Worth running before every deploy — a wrong key or an unfunded account fails several
 * transactions in, leaving a half-deployed system to clean up.
 */
async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No account configured. Set PRIVATE_KEY in contracts/.env to a 64-character hex key " +
        "(with or without the 0x prefix).",
    );
  }

  const [signer] = signers;
  const chain = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(signer.address);
  const nonce = await ethers.provider.getTransactionCount(signer.address);

  console.log(`\nNetwork   ${network.name} (chainId ${chain.chainId})`);
  console.log(`Deployer  ${signer.address}`);
  console.log(`Balance   ${ethers.formatEther(balance)} ETH`);
  console.log(`Nonce     ${nonce}`);

  // A full deploy is 4 contracts; ~0.01 ETH is comfortable on Base at typical testnet gas.
  const needed = ethers.parseEther("0.01");
  if (balance < needed) {
    console.log(
      `\nBalance looks low for a full deploy (~${ethers.formatEther(needed)} ETH recommended).`,
    );
    if (chain.chainId === 84532n) {
      console.log("Base Sepolia faucet: https://www.alchemy.com/faucets/base-sepolia");
    }
  } else {
    console.log("\nReady to deploy.");
  }
  console.log();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
