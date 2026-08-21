// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPumperMigrator} from "./interfaces/IPumperMigrator.sol";
import {
    IUniswapV2Factory,
    IUniswapV2Pair,
    IUniswapV2Router02,
    IWETH
} from "./interfaces/IUniswapV2.sol";

/**
 * @title UniswapV2Migrator
 * @notice Seeds a Uniswap V2 pair with a graduated token's liquidity through the canonical
 *         UniswapV2Router02, and permanently burns the resulting LP tokens.
 *
 * @dev Design notes:
 *
 *      **The canonical router performs the liquidity add.** `addLiquidityETH` wraps the ETH,
 *      moves both sides into the pair and mints, in one call. The router is immutable, has no
 *      admin and no upgrade path, so adopting it adds no trust assumption beyond Uniswap itself.
 *      The factory is still called directly for `getPair`/`createPair`, because the router
 *      derives the pair address from a hard-coded init-code hash rather than from the registry.
 *      The two must agree, so {migrate} asserts that the LP it received belongs to the pair the
 *      factory names ({PairMismatch}), and the constructor pins `router.factory()` and
 *      `router.WETH()` to this contract's own immutables — making a mis-wired deployment
 *      impossible rather than merely unlikely.
 *
 *      **No privileges, no state.** The only stored values are four immutables. There is no
 *      owner, no rescue function, and no way for anyone to pull assets out. `migrate` is
 *      callable only by the launchpad, and every asset that enters this contract in a given call
 *      leaves it in the same call — into the pair, into the burn address, or back to the
 *      launchpad. The router's token allowance is set immediately before the add and cleared
 *      immediately after, so no standing approval survives a call.
 *
 *      **The LP burn is permanent and verifiable.** LP tokens are minted to this contract and
 *      immediately transferred to `0x...dEaD`, and the call asserts this contract's LP balance is
 *      zero afterwards. `0x...dEaD` has no known private key; anyone can verify the burn on-chain
 *      by reading `pair.balanceOf(0x...dEaD)` against the `LiquidityMigrated` event. This
 *      contract holds no LP tokens between calls, so there is nothing to withdraw even in
 *      principle.
 */
contract UniswapV2Migrator is IPumperMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where LP tokens (and any undepositable tokens) go, irreversibly.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice The only address permitted to call {migrate}.
    address public immutable launchpad;

    /// @notice Canonical UniswapV2Router02 — performs the liquidity add.
    IUniswapV2Router02 public immutable uniswapV2Router;

    /// @notice Canonical UniswapV2Factory — pair lookup and creation. Equals `router.factory()`.
    IUniswapV2Factory public immutable uniswapV2Factory;

    /// @notice Canonical WETH, the pair's quote asset. Equals `router.WETH()`.
    IWETH public immutable weth;

    event Migrated(
        address indexed token,
        address indexed pair,
        uint256 ethDeposited,
        uint256 tokenDeposited,
        uint256 lpBurned,
        uint256 tokensBurned,
        uint256 ethReturned
    );

    error OnlyLaunchpad();
    error ZeroAddress();
    error NothingToMigrate();
    error TokenBalanceShortfall();
    error PairCreationFailed();
    error PairMintFailed();
    error PairMismatch();
    error PairRatioUnusable();
    error LpBurnIncomplete();
    error EthReturnFailed();
    error DirectEthNotAccepted();
    error RouterFactoryMismatch();
    error RouterWethMismatch();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    /**
     * @param launchpad_        The {PumperFactory} this migrator serves.
     * @param uniswapV2Router_  Canonical UniswapV2Router02.
     * @param uniswapV2Factory_ Canonical UniswapV2Factory. Must equal `uniswapV2Router_.factory()`.
     * @param weth_             Canonical WETH. Must equal `uniswapV2Router_.WETH()`.
     */
    constructor(
        address launchpad_,
        address uniswapV2Router_,
        address uniswapV2Factory_,
        address weth_
    ) {
        if (
            launchpad_ == address(0) || uniswapV2Router_ == address(0)
                || uniswapV2Factory_ == address(0) || weth_ == address(0)
        ) revert ZeroAddress();

        // Pin the router to the factory and the WETH this contract uses for pair lookup and for
        // the fallback mint. Without this the two could disagree, and liquidity could be minted
        // into a pair whose LP tokens this contract never sees, let alone burns.
        if (IUniswapV2Router02(uniswapV2Router_).factory() != uniswapV2Factory_) {
            revert RouterFactoryMismatch();
        }
        if (IUniswapV2Router02(uniswapV2Router_).WETH() != weth_) revert RouterWethMismatch();

        launchpad = launchpad_;
        uniswapV2Router = IUniswapV2Router02(uniswapV2Router_);
        uniswapV2Factory = IUniswapV2Factory(uniswapV2Factory_);
        weth = IWETH(weth_);
    }

    /// @inheritdoc IPumperMigrator
    function migrate(address token, uint256 tokenAmount)
        external
        payable
        override
        onlyLaunchpad
        nonReentrant
        returns (
            address pair,
            uint256 ethDeposited,
            uint256 tokenDeposited,
            uint256 lpBurned,
            uint256 tokensBurned,
            uint256 ethReturned
        )
    {
        uint256 ethAmount = msg.value;
        if (ethAmount == 0 || tokenAmount == 0) revert NothingToMigrate();
        if (IERC20(token).balanceOf(address(this)) < tokenAmount) revert TokenBalanceShortfall();

        pair = uniswapV2Factory.getPair(token, address(weth));
        if (pair == address(0)) {
            pair = uniswapV2Factory.createPair(token, address(weth));
            if (pair == address(0)) revert PairCreationFailed();
        }

        // Measured as a delta, never as an absolute balance: anyone can transfer LP tokens of a
        // pre-created pair to this contract, and an equality against the absolute balance would
        // then let one wei of donated LP block the migration for good.
        uint256 lpBefore = IUniswapV2Pair(pair).balanceOf(address(this));

        uint256 minted;
        (ethDeposited, tokenDeposited, minted) = _addLiquidity(pair, token, ethAmount, tokenAmount);
        if (minted == 0) revert PairMintFailed();

        lpBurned = IUniswapV2Pair(pair).balanceOf(address(this));
        // Ties the router's hard-coded pair derivation back to the factory registry: what it
        // minted must be LP of the exact pair this contract is about to burn and report. A
        // router/factory disagreement fails here instead of silently stranding liquidity in a
        // pool nobody burns.
        if (lpBurned - lpBefore != minted) revert PairMismatch();

        // Permanent, verifiable LP burn — of everything held, so donated LP is burned too and
        // this contract is guaranteed to end the call with none.
        IERC20(pair).safeTransfer(BURN_ADDRESS, lpBurned);
        if (IUniswapV2Pair(pair).balanceOf(address(this)) != 0) revert LpBurnIncomplete();

        // Residual tokens — the undeposited remainder, reachable only if the pair was pre-seeded
        // by a third party (see {_addLiquidity}), plus anything donated to this contract. Burned
        // rather than kept: this contract has no way to use or release them otherwise.
        tokensBurned = IERC20(token).balanceOf(address(this));
        if (tokensBurned > 0) {
            IERC20(token).safeTransfer(BURN_ADDRESS, tokensBurned);
        }

        // Sweep rather than subtract. This is the router's refund of the ETH it could not
        // deposit, and sweeping additionally guarantees the contract never retains ETH — not
        // even ETH force-sent by `selfdestruct`, which no `receive` guard can refuse. The
        // launchpad books whatever arrives into its fee ledger, so its accounting invariant
        // holds either way.
        ethReturned = address(this).balance;
        if (ethReturned > 0) {
            (bool ok,) = launchpad.call{value: ethReturned}("");
            if (!ok) revert EthReturnFailed();
        }

        emit Migrated(
            token, pair, ethDeposited, tokenDeposited, lpBurned, tokensBurned, ethReturned
        );
    }

    /**
     * @dev Adds the liquidity and reports what was actually moved.
     *
     *      Normal path: the pair is brand new and empty, so the full amounts are deposited and
     *      the launchpad's intended ratio becomes the pool's opening price.
     *
     *      Adversarial path: anyone can create the pair and seed it with a dust amount at an
     *      absurd ratio before migration. Depositing blindly would mint LP against the *worse*
     *      side of that ratio and silently donate the excess to the squatter — a real theft
     *      vector, not just griefing. So when reserves already exist the deposit is made
     *      strictly at the existing ratio. Those amounts are solved here with the exact formulas
     *      `UniswapV2Router02._addLiquidity` uses and then passed *as the minimums*, while the
     *      full amounts are passed as the desired values — so the router's own computation lands
     *      on the same numbers and the minimums bind precisely. The squatter gains nothing; the
     *      surplus token side is burned and the surplus ETH goes back to the launchpad.
     *
     *      Reverting on a pre-seeded pair was rejected as the alternative: it would let anyone
     *      permanently block a token's migration for the price of one dust transfer.
     *
     *      Degenerate path: a pair with exactly one non-zero reserve, reachable by transferring
     *      dust to a fresh pair and calling `sync()` before anyone mints. `UniswapV2Library.quote`
     *      requires *both* reserves to be non-zero, so the router reverts outright on that state;
     *      routing through it unconditionally would hand anyone a permanent, one-wei denial of
     *      service over a graduated token's ETH. Such a pair has no tradeable price at all
     *      (`swap` needs both sides), so minting on it directly is equivalent to minting on an
     *      empty one: the full amounts go in, the opening price is ours, and the stray dust is
     *      absorbed into the pool.
     */
    function _addLiquidity(address pair, address token, uint256 ethAmount, uint256 tokenAmount)
        private
        returns (uint256 ethDeposited, uint256 tokenDeposited, uint256 liquidity)
    {
        (uint256 reserveToken, uint256 reserveWeth) = _reserves(pair, token);

        if ((reserveToken == 0) != (reserveWeth == 0)) {
            return _mintDirect(pair, token, ethAmount, tokenAmount);
        }

        uint256 tokenMin;
        uint256 ethMin;
        if (reserveToken == 0) {
            // Empty pair — the normal path. Exact deposit, so the pool opens at the curve's
            // final price.
            (tokenMin, ethMin) = (tokenAmount, ethAmount);
        } else {
            uint256 ethOptimal = (tokenAmount * reserveWeth) / reserveToken;
            if (ethOptimal <= ethAmount) {
                (tokenMin, ethMin) = (tokenAmount, ethOptimal);
            } else {
                (tokenMin, ethMin) = ((ethAmount * reserveToken) / reserveWeth, ethAmount);
            }
            // A ratio so lopsided that one side rounds away to nothing cannot be deposited
            // against — the pair would mint zero LP. Fail with a precise reason rather than an
            // opaque Uniswap revert. Depositing the full amounts instead is not an option: that
            // is exactly the donation the ratio matching exists to prevent.
            if (tokenMin == 0 || ethMin == 0) revert PairRatioUnusable();
        }

        // Exact-amount approval immediately before the call, cleared immediately after, so this
        // contract never carries a standing allowance between migrations.
        IERC20(token).forceApprove(address(uniswapV2Router), tokenAmount);

        (tokenDeposited, ethDeposited, liquidity) = uniswapV2Router.addLiquidityETH{
            value: ethAmount
        }(token, tokenAmount, tokenMin, ethMin, address(this), block.timestamp);

        IERC20(token).forceApprove(address(uniswapV2Router), 0);
    }

    /// @dev Mints on the pair directly. Used only for the degenerate one-sided-reserve state the
    ///      router cannot service; see {_addLiquidity}.
    function _mintDirect(address pair, address token, uint256 ethAmount, uint256 tokenAmount)
        private
        returns (uint256 ethDeposited, uint256 tokenDeposited, uint256 liquidity)
    {
        weth.deposit{value: ethAmount}();
        IERC20(address(weth)).safeTransfer(pair, ethAmount);
        IERC20(token).safeTransfer(pair, tokenAmount);
        liquidity = IUniswapV2Pair(pair).mint(address(this));
        return (ethAmount, tokenAmount, liquidity);
    }

    /// @dev Pair reserves normalised to (token, WETH) regardless of Uniswap's sort order.
    function _reserves(address pair, address token)
        private
        view
        returns (uint256 reserveToken, uint256 reserveWeth)
    {
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
        return IUniswapV2Pair(pair).token0() == token
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));
    }

    /// @notice The pair address for `token`, or `address(0)` if it does not exist yet.
    function pairFor(address token) external view returns (address) {
        return uniswapV2Factory.getPair(token, address(weth));
    }

    /// @dev ETH arrives as `msg.value` on {migrate}, and as the router refunding whatever it
    ///      could not deposit. Anything else is a mistake.
    receive() external payable {
        if (msg.sender != address(uniswapV2Router)) revert DirectEthNotAccepted();
    }
}
