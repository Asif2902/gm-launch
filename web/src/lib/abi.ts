/**
 * Hand-maintained slice of the factory ABI covering everything the UI calls.
 * Regenerate the full ABI with `npm run abis` in the contracts package; the signatures below
 * must match `contracts/abis/PumperFactory.json`.
 */
export const FACTORY_ABI = [
  // --- writes ---
  {
    type: "function",
    name: "createToken",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "minTokensOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "minEthOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "ethOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "migrate",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimPendingEth",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },

  // --- reads ---
  {
    type: "function",
    name: "getToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "view_",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "creator", type: "address" },
          { name: "status", type: "uint8" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "totalSupply", type: "uint256" },
          { name: "circulatingSupply", type: "uint256" },
          { name: "ethReserve", type: "uint256" },
          { name: "virtualEthReserve", type: "uint256" },
          { name: "tokenReserve", type: "uint256" },
          { name: "virtualTokenReserve", type: "uint256" },
          { name: "tokenPrice", type: "uint256" },
          { name: "marketCap", type: "uint256" },
          { name: "fullyDilutedValuation", type: "uint256" },
          { name: "tokensAvailable", type: "uint256" },
          { name: "migrationProgressBps", type: "uint256" },
          { name: "cumulativeEthIn", type: "uint256" },
          { name: "cumulativeEthOut", type: "uint256" },
          { name: "cumulativeTokensBought", type: "uint256" },
          { name: "cumulativeTokensSold", type: "uint256" },
          { name: "createdAt", type: "uint256" },
          { name: "migratedAt", type: "uint256" },
          { name: "pair", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quoteBuy",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "ethIn", type: "uint256" },
    ],
    outputs: [
      { name: "fee", type: "uint256" },
      { name: "ethAfterFee", type: "uint256" },
      { name: "tokensOut", type: "uint256" },
      { name: "refund", type: "uint256" },
      { name: "priceAfter", type: "uint256" },
      { name: "triggersMigration", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "quoteSell",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "tokensIn", type: "uint256" },
    ],
    outputs: [
      { name: "grossEthOut", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "ethOut", type: "uint256" },
      { name: "priceAfter", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewMigration",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "ethToPool", type: "uint256" },
      { name: "tokensToPool", type: "uint256" },
      { name: "tokensToBurn", type: "uint256" },
      { name: "openingPrice", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "allTokensLength",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingEth",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },

  // --- events used for post-transaction confirmation ---
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "totalSupply", type: "uint256", indexed: false },
      { name: "virtualEthReserve", type: "uint256", indexed: false },
      { name: "virtualTokenReserve", type: "uint256", indexed: false },
      { name: "migrationThreshold", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
