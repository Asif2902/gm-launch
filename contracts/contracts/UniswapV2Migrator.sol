// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPumperMigrator} from "./interfaces/IPumperMigrator.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IWETH} from "./interfaces/IUniswapV2.sol";

/**
 * @title UniswapV2Migrator
 * @notice Seeds a Uniswap V2 pair with a graduated token's liquidity and permanently burns the
 *         resulting LP tokens.
 *
 * @dev Design notes:
 *
 *      **No router.** Liquidity is added by transferring both assets straight to the pair and
 *      calling {IUniswapV2Pair-mint}. UniswapV2Router02 derives the pair address with
 *      `UniswapV2Library.pairFor`, which hardcodes an init-code hash that only matches the
 *      canonical deployment — using the factory's own `getPair` instead makes this contract work
 *      against any V2-compatible factory, and removes an external contract from the trust set.
 *
 *      **No privileges, no state.** The only stored values are three immutables. There is no
 *      owner, no rescue function, and no way for anyone to pull assets out. `migrate` is
 *      callable only by the launchpad, and every asset that enters this contract in a given call
 *      leaves it in the same call — into the pair, into the burn address, or back to the
 *      launchpad.
 *
 *      **The LP burn is permanent and verifiable.** LP tokens are minted to this contract and
 *      immediately transferred to `0x…dEaD`, and the call asserts this contract's LP balance is
 *      zero afterwards. `0x…dEaD` has no known private key; anyone can verify the burn on-chain
 *      by reading `pair.balanceOf(0x…dEaD)` against the `LiquidityMigrated` event. This contract
 *      holds no LP tokens between calls, so there is nothing to withdraw even in principle.
 */
contract UniswapV2Migrator is IPumperMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where LP tokens (and any undepositable tokens) go, irreversibly.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice The only address permitted to call {migrate}.
    address public immutable launchpad;

    /// @notice Uniswap V2 factory used to look up / create the pair.
    IUniswapV2Factory public immutable uniswapV2Factory;

    /// @notice Canonical WETH used as the pair's quote asset.
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
    error PairMintFailed();
    error LpBurnIncomplete();
    error EthReturnFailed();
    error DirectEthNotAccepted();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    constructor(address launchpad_, address uniswapV2Factory_, address weth_) {
        if (launchpad_ == address(0) || uniswapV2Factory_ == address(0) || weth_ == address(0)) {
            revert ZeroAddress();
        }
        launchpad = launchpad_;
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
        }

        (ethDeposited, tokenDeposited) = _depositAmounts(pair, token, ethAmount, tokenAmount);

        // Add liquidity: transfer both sides in, then mint. Because the pair is normally empty,
        // this single step *sets* the opening price to the exact ratio computed by the launchpad.
        weth.deposit{value: ethDeposited}();
        IERC20(address(weth)).safeTransfer(pair, ethDeposited);
        IERC20(token).safeTransfer(pair, tokenDeposited);

        lpBurned = IUniswapV2Pair(pair).mint(address(this));
        if (lpBurned == 0) revert PairMintFailed();

        // Permanent, verifiable LP burn.
        IERC20(pair).safeTransfer(BURN_ADDRESS, lpBurned);
        if (IUniswapV2Pair(pair).balanceOf(address(this)) != 0) revert LpBurnIncomplete();

        // Residuals — only reachable if the pair was pre-seeded by a third party (see
        // {_depositAmounts}). Tokens are burned rather than kept; ETH goes back to the launchpad.
        tokensBurned = tokenAmount - tokenDeposited;
        if (tokensBurned > 0) {
            IERC20(token).safeTransfer(BURN_ADDRESS, tokensBurned);
        }

        ethReturned = ethAmount - ethDeposited;
        if (ethReturned > 0) {
            (bool ok,) = launchpad.call{value: ethReturned}("");
            if (!ok) revert EthReturnFailed();
        }

        emit Migrated(token, pair, ethDeposited, tokenDeposited, lpBurned, tokensBurned, ethReturned);
    }

    /**
     * @dev Chooses how much of each asset to deposit.
     *
     *      Normal path: the pair is brand new and empty, so everything is deposited and the
     *      launchpad's intended ratio becomes the pool's opening price.
     *
     *      Adversarial path: anyone can create the pair and seed it with a dust amount at an
     *      absurd ratio before migration. Depositing blindly would mint LP against the *worse*
     *      side of that ratio and silently donate the excess to the squatter — a real theft
     *      vector, not just griefing. So when reserves already exist we deposit strictly at the
     *      existing ratio (the standard `quote`), capping at whatever we hold on each side. The
     *      squatter gains nothing; the surplus token side is burned and the surplus ETH goes
     *      back to the launchpad.
     *
     *      Reverting on a pre-seeded pair was rejected as the alternative: it would let anyone
     *      permanently block a token's migration for the price of one dust transfer.
     */
    function _depositAmounts(address pair, address token, uint256 ethAmount, uint256 tokenAmount)
        private
        view
        returns (uint256 ethDeposited, uint256 tokenDeposited)
    {
        (uint256 reserveToken, uint256 reserveWeth) = _reserves(pair, token);

        if (reserveToken == 0 || reserveWeth == 0) {
            return (ethAmount, tokenAmount);
        }

        uint256 ethOptimal = (tokenAmount * reserveWeth) / reserveToken;
        if (ethOptimal <= ethAmount) {
            return (ethOptimal, tokenAmount);
        }
        return (ethAmount, (ethAmount * reserveToken) / reserveWeth);
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

    /// @dev ETH only ever arrives as `msg.value` on {migrate}; anything else is a mistake.
    receive() external payable {
        revert DirectEthNotAccepted();
    }
}
