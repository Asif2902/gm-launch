// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal surface of the Uniswap V2 factory used by {UniswapV2Migrator}.
/// @dev Base mainnet: 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6.
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/**
 * @notice Minimal surface of UniswapV2Router02, the canonical liquidity entry point.
 * @dev Base mainnet: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24.
 *
 *      `factory()` and `WETH()` are declared `pure` on the router itself (they read
 *      immutables). They are declared `view` here because that is the weaker, always-valid
 *      guarantee for a caller — the ABI encoding and the STATICCALL are identical either way.
 *
 *      The migrator asserts both getters against its own immutables at construction, so a
 *      router wired to a different factory or a different WETH can never be adopted.
 */
interface IUniswapV2Router02 {
    function factory() external view returns (address);

    function WETH() external view returns (address);

    /**
     * @notice Adds `token`/ETH liquidity, wrapping the attached ETH into WETH internally.
     * @dev Pulls `amountToken` from the caller via `transferFrom` (an allowance is required),
     *      mints LP to `to`, and refunds `msg.value - amountETH` to the caller — which is why
     *      {UniswapV2Migrator-receive} must accept ETH from this address.
     */
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

/**
 * @notice Minimal surface of a Uniswap V2 pair.
 * @dev Used for reserve inspection, the LP burn, and the direct-mint fallback that covers the
 *      one pair state UniswapV2Library rejects (see {UniswapV2Migrator-_addLiquidity}).
 */
interface IUniswapV2Pair {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    function mint(address to) external returns (uint256 liquidity);

    function totalSupply() external view returns (uint256);

    function balanceOf(address owner) external view returns (uint256);

    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice Canonical WETH9 surface (Base mainnet and Base Sepolia:
///         0x4200000000000000000000000000000000000006).
interface IWETH {
    function deposit() external payable;

    function withdraw(uint256 amount) external;

    function transfer(address to, uint256 value) external returns (bool);

    function balanceOf(address owner) external view returns (uint256);
}
