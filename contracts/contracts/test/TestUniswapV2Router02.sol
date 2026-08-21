// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV2Factory, IUniswapV2Pair, IWETH} from "../interfaces/IUniswapV2.sol";

/**
 * @title TestUniswapV2Router02
 * @notice Local stand-in for UniswapV2Router02's `addLiquidityETH` path. **Tests only** — never
 *         deployed to a production network, where the canonical router is used instead (Base
 *         mainnet: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24).
 *
 * @dev The arithmetic, the ordering and the revert conditions are transcribed from
 *      UniswapV2Router02 / UniswapV2Library so the migrator meets identical behaviour here and
 *      on-chain: the same `quote` rounding, the same `INSUFFICIENT_*` requires, the same
 *      transfer-then-mint sequence, and the same refund of undeposited ETH to `msg.sender`.
 *
 *      One deliberate difference: the pair is resolved with `factory.getPair` rather than
 *      `UniswapV2Library.pairFor`. `pairFor` hard-codes the init-code hash of the canonical
 *      UniswapV2Pair, which does not match a pair compiled locally by this repo's toolchain, so
 *      a transcribed `pairFor` would resolve to an empty address in every local test. The
 *      migrator asserts the two agree in production ({UniswapV2Migrator-PairMismatch}), and the
 *      Base-mainnet fork test exercises the real router with the real hash.
 */
contract TestUniswapV2Router02 {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable WETH;

    constructor(address factory_, address weth_) {
        factory = factory_;
        WETH = weth_;
    }

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "UniswapV2Router: EXPIRED");
        _;
    }

    /// @dev UniswapV2Library.quote.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        public
        pure
        returns (uint256 amountB)
    {
        require(amountA > 0, "UniswapV2Library: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "UniswapV2Library: INSUFFICIENT_LIQUIDITY");
        amountB = (amountA * reserveB) / reserveA;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        ensure(deadline)
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        (amountToken, amountETH) =
            _addLiquidity(token, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);

        address pair = IUniswapV2Factory(factory).getPair(token, WETH);
        IERC20(token).safeTransferFrom(msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        require(IWETH(WETH).transfer(pair, amountETH), "UniswapV2Router: WETH_TRANSFER_FAILED");
        liquidity = IUniswapV2Pair(pair).mint(to);

        if (msg.value > amountETH) {
            (bool ok,) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "TransferHelper: ETH_TRANSFER_FAILED");
        }
    }

    /// @dev UniswapV2Router02._addLiquidity, with A = token and B = WETH.
    function _addLiquidity(
        address token,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private returns (uint256 amountA, uint256 amountB) {
        if (IUniswapV2Factory(factory).getPair(token, WETH) == address(0)) {
            IUniswapV2Factory(factory).createPair(token, WETH);
        }
        (uint256 reserveA, uint256 reserveB) = _reserves(token);

        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "UniswapV2Router: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "UniswapV2Router: INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    /// @dev Reserves normalised to (token, WETH), as UniswapV2Library.getReserves does.
    function _reserves(address token) private view returns (uint256 reserveA, uint256 reserveB) {
        address pair = IUniswapV2Factory(factory).getPair(token, WETH);
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
        return IUniswapV2Pair(pair).token0() == token
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));
    }
}
