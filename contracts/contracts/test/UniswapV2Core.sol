// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.5.16;

// Pulls the genuine Uniswap V2 core sources into the compilation unit so integration tests run
// against the real UniswapV2Factory / UniswapV2Pair bytecode rather than a hand-written mock.
// Compiled with solc 0.5.16 (see hardhat.config.ts). Not deployed to production networks —
// Base Sepolia already hosts a live V2 factory at 0x7Ae58f10f7849cA6F5fB71b7f45CB416c9204b1e.
import "@uniswap/v2-core/contracts/UniswapV2Factory.sol";
