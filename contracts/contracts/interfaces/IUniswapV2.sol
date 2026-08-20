// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal surface of the Uniswap V2 factory used by {UniswapV2Migrator}.
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/**
 * @notice Minimal surface of a Uniswap V2 pair.
 * @dev The migrator deposits by transferring both assets to the pair and calling {mint}
 *      directly, rather than going through UniswapV2Router02. That avoids the router's
 *      `UniswapV2Library.pairFor` CREATE2 init-code-hash assumption (which differs between the
 *      canonical deployment and any fork/local deployment), removes a trusted intermediary, and
 *      makes the deposit a single atomic step we fully control.
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

/// @notice Canonical WETH9 surface (Base Sepolia: 0x4200000000000000000000000000000000000006).
interface IWETH {
    function deposit() external payable;

    function withdraw(uint256 amount) external;

    function transfer(address to, uint256 value) external returns (bool);

    function balanceOf(address owner) external view returns (uint256);
}
