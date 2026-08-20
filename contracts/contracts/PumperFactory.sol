// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BondingCurve} from "./libraries/BondingCurve.sol";
import {IPumperToken} from "./interfaces/IPumperToken.sol";
import {IPumperMigrator} from "./interfaces/IPumperMigrator.sol";

/**
 * @title PumperFactory
 * @notice Token factory, registry, bonding-curve AMM, fee ledger and migration controller for
 *         the Pumper launchpad.
 *
 * @dev **Why one contract?** Every protocol event originates here, so an indexer subscribes to a
 *      single address and a single ABI to reconstruct the entire system — no per-token contract
 *      discovery, no internal-transaction tracing, no deployment scanning (spec §7). The pieces
 *      that genuinely benefit from isolation are separated out: the curve math is a pure library
 *      ({BondingCurve}), the token is its own standardised implementation ({PumperToken}), and
 *      all Uniswap interaction lives behind {IPumperMigrator}.
 *
 *      **Admin surface** is deliberately near-zero. Fee rates, the curve constants and the
 *      migration threshold are `constant`. The token implementation and the migrator are
 *      `immutable`. The owner's *only* power is redirecting future fee withdrawals via
 *      {setFeeRecipient}; it cannot touch reserves, tokens, trading or migration. There is no
 *      pause, no upgrade, no rescue, no blacklist.
 *
 *      **ETH accounting.** At all times:
 *          `address(this).balance == Σ ethReserve + accruedFees + Σ pendingEth`
 *      Untracked ETH cannot enter: {receive} rejects everyone except the migrator returning
 *      undeposited funds.
 *
 *      Economics, rounding policy and the migration derivation: `docs/ECONOMICS.md`.
 */
contract PumperFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------
    // Constants — all published on-chain so an indexer can bootstrap without hardcoding.
    // ---------------------------------------------------------------------------------------

    /// @notice Fixed supply of every launched token: 1,000,000,000 with 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Virtual ETH seeded into every curve. The curve's only virtual component.
    uint256 public constant VIRTUAL_ETH_RESERVE = 0.5 ether;

    /// @notice Virtual token reserve at genesis. Equals the real token reserve by construction.
    uint256 public constant VIRTUAL_TOKEN_RESERVE = TOTAL_SUPPLY;

    /// @notice Constant-product invariant `k = E * T` = 5e44.
    uint256 public constant CURVE_INVARIANT = VIRTUAL_ETH_RESERVE * VIRTUAL_TOKEN_RESERVE;

    /// @notice Real, post-fee ETH a curve must hold to graduate. See ECONOMICS §7 — this is
    ///         explicitly the ETH *held by the curve*, not gross buyer spend.
    uint256 public constant MIGRATION_THRESHOLD = 5 ether;

    /// @notice Token reserve at the moment of migration: `k / (0.5 + 5)` ETH.
    uint256 public constant TOKEN_RESERVE_AT_MIGRATION =
        CURVE_INVARIANT / (VIRTUAL_ETH_RESERVE + MIGRATION_THRESHOLD);

    /// @notice 0.20 %, charged on the ETH *input* of a buy.
    uint256 public constant BUY_FEE_BPS = 20;

    /// @notice 0.30 %, charged on the gross ETH *output* of a sell.
    uint256 public constant SELL_FEE_BPS = 30;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice `action` value in {PlatformFeeCollected} for a buy.
    uint8 public constant ACTION_BUY = 0;

    /// @notice `action` value in {PlatformFeeCollected} for a sell.
    uint8 public constant ACTION_SELL = 1;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 private constant MAX_NAME_LENGTH = 64;
    uint256 private constant MAX_SYMBOL_LENGTH = 16;

    /// @dev Gas forwarded on *push* ETH transfers. Bounded so a receiver that burns gas cannot
    ///      brick the trade; on failure the amount is credited to {pendingEth} instead.
    uint256 private constant ETH_PUSH_GAS_LIMIT = 100_000;

    // ---------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------

    enum Status {
        None,             // 0 — not a launchpad token
        Trading,          // 1 — bonding curve is live
        PendingMigration, // 2 — threshold reached, trading halted, awaiting migrate()
        Migrated          // 3 — liquidity is on Uniswap V2, curve permanently closed
    }

    /// @dev Five storage slots, tightly packed. `ethReserve` ≤ 5e18 and `tokenReserve` ≤ 1e27
    ///      both fit comfortably in uint128 (max ≈ 3.4e38).
    struct TokenData {
        // slot 0
        uint128 ethReserve;   // real ETH held by the curve, net of fees
        uint128 tokenReserve; // tokens remaining in the curve
        // slot 1
        address creator;
        uint40 createdAt;
        Status status;
        // slot 2
        uint128 cumulativeEthIn;  // lifetime post-fee ETH into the curve
        uint128 cumulativeEthOut; // lifetime gross ETH out of the curve
        // slot 3
        uint128 cumulativeTokensBought;
        uint128 cumulativeTokensSold;
        // slot 4
        address pair;
        uint40 migratedAt;
    }

    /// @dev Everything a token page needs, in one call. Values are derived from the same state
    ///      the events report, so frontend and indexer can never disagree with the chain.
    struct TokenView {
        address token;
        address creator;
        Status status;
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 circulatingSupply;
        uint256 ethReserve;
        uint256 virtualEthReserve;
        uint256 tokenReserve;
        uint256 virtualTokenReserve;
        uint256 tokenPrice;
        uint256 marketCap;
        uint256 fullyDilutedValuation;
        uint256 tokensAvailable;
        uint256 migrationProgressBps;
        uint256 cumulativeEthIn;
        uint256 cumulativeEthOut;
        uint256 cumulativeTokensBought;
        uint256 cumulativeTokensSold;
        uint256 createdAt;
        uint256 migratedAt;
        address pair;
    }

    /// @dev Grouped to keep {_buy} clear of stack pressure.
    struct BuyQuote {
        uint256 grossUsed; // ETH actually consumed by the trade
        uint256 fee;       // platform fee inside `grossUsed`
        uint256 netEth;    // ETH that reaches the curve
        uint256 refund;    // ETH returned to the buyer (threshold pinning)
    }

    // ---------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------

    /// @notice The {PumperToken} implementation every clone delegates to.
    address public immutable tokenImplementation;

    /// @notice The Uniswap V2 migration module.
    IPumperMigrator public immutable migrator;

    /// @notice On-chain registry — the event stream remains the primary discovery mechanism.
    mapping(address => bool) public isLaunchpadToken;

    /// @notice Every token ever launched, in creation order.
    address[] public allTokens;

    mapping(address => TokenData) private _tokenData;

    /// @notice ETH owed to an address whose push transfer failed. Claim via {claimPendingEth}.
    mapping(address => uint256) public pendingEth;

    /// @notice Platform fees accumulated in ETH, awaiting {withdrawFees}.
    uint256 public accruedFees;

    /// @notice Destination of {withdrawFees}. The owner's only lever.
    address public feeRecipient;

    // ---------------------------------------------------------------------------------------
    // Events — the complete indexing surface (spec §6).
    // ---------------------------------------------------------------------------------------

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve,
        uint256 migrationThreshold,
        uint256 timestamp
    );

    /// @dev `ethReserve` is the curve's real ETH (migration progress = ethReserve /
    ///      MIGRATION_THRESHOLD); `virtualEthReserve` is the pricing reserve
    ///      (VIRTUAL_ETH_RESERVE + ethReserve). Both are emitted so the indexer needs no
    ///      knowledge of protocol constants. `tokenPrice` is wei per whole token, post-trade.
    event TokenBought(
        address indexed token,
        address indexed buyer,
        uint256 ethIn,
        uint256 fee,
        uint256 ethAfterFee,
        uint256 tokensOut,
        uint256 tokenPrice,
        uint256 ethReserve,
        uint256 virtualEthReserve,
        uint256 tokenReserve,
        uint256 timestamp
    );

    /// @dev `grossEthOut` is what the curve released; `ethOut` is what the seller received
    ///      (`grossEthOut - fee`). The curve's ETH falls by the gross amount.
    event TokenSold(
        address indexed token,
        address indexed seller,
        uint256 tokensIn,
        uint256 grossEthOut,
        uint256 fee,
        uint256 ethOut,
        uint256 tokenPrice,
        uint256 ethReserve,
        uint256 virtualEthReserve,
        uint256 tokenReserve,
        uint256 timestamp
    );

    event MigrationTriggered(
        address indexed token, uint256 ethReserve, uint256 tokenReserve, uint256 timestamp
    );

    event LiquidityMigrated(
        address indexed token,
        address indexed pair,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 tokensBurned,
        uint256 lpTokensBurned,
        uint256 timestamp
    );

    event PlatformFeeCollected(
        address indexed token,
        address indexed user,
        uint8 indexed action,
        uint256 amount,
        uint256 timestamp
    );

    event BuyRefunded(address indexed token, address indexed buyer, uint256 amount, uint256 timestamp);
    event EthCredited(address indexed account, uint256 amount, uint256 timestamp);
    event EthClaimed(address indexed account, uint256 amount, uint256 timestamp);
    event FeesWithdrawn(address indexed recipient, uint256 amount, uint256 timestamp);
    event FeeRecipientUpdated(address indexed previous, address indexed current);

    // ---------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error UnknownToken();
    error NotTrading();
    error MigrationNotReady();
    error SlippageExceeded();
    error DeadlinePassed();
    error InvalidName();
    error InvalidSymbol();
    error InsufficientCurveLiquidity();
    error EthTransferFailed();
    error DirectEthNotAccepted();
    error MigratorMismatch();
    error NothingToClaim();

    // ---------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------

    /**
     * @param tokenImplementation_ Deployed {PumperToken} used as the clone template.
     * @param migrator_            Deployed {UniswapV2Migrator}, already pointed at this address.
     * @param feeRecipient_        Initial destination for platform fees.
     * @param owner_               Initial owner (may only change `feeRecipient`).
     *
     * @dev The migrator and the launchpad reference each other, so the deploy script predicts
     *      this contract's address (CREATE nonce) and passes it to the migrator first. The
     *      constructor then verifies the link, making a mis-wired deployment impossible rather
     *      than merely unlikely.
     */
    constructor(
        address tokenImplementation_,
        address migrator_,
        address feeRecipient_,
        address owner_
    ) Ownable(owner_) {
        if (
            tokenImplementation_ == address(0) || migrator_ == address(0)
                || feeRecipient_ == address(0) || owner_ == address(0)
        ) revert ZeroAddress();

        if (IPumperMigrator(migrator_).launchpad() != address(this)) revert MigratorMismatch();

        tokenImplementation = tokenImplementation_;
        migrator = IPumperMigrator(migrator_);
        feeRecipient = feeRecipient_;

        emit FeeRecipientUpdated(address(0), feeRecipient_);
    }

    // ---------------------------------------------------------------------------------------
    // Token creation
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Launch a token. Name and symbol are the only inputs (spec §1).
     * @dev Any ETH sent is immediately spent on a buy for the creator, so a launch-and-buy is a
     *      single transaction. Sending zero is perfectly normal and the frontend's default.
     * @return token Address of the newly deployed clone.
     */
    function createToken(string calldata name, string calldata symbol)
        external
        payable
        nonReentrant
        returns (address token)
    {
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) revert InvalidName();
        uint256 symbolLength = bytes(symbol).length;
        if (symbolLength == 0 || symbolLength > MAX_SYMBOL_LENGTH) revert InvalidSymbol();

        token = Clones.cloneDeterministic(tokenImplementation, _salt(msg.sender, allTokens.length));
        IPumperToken(token).initialize(name, symbol, msg.sender, address(this));

        TokenData storage data = _tokenData[token];
        data.creator = msg.sender;
        data.createdAt = uint40(block.timestamp);
        data.status = Status.Trading;
        data.tokenReserve = uint128(TOTAL_SUPPLY);

        isLaunchpadToken[token] = true;
        allTokens.push(token);

        emit TokenCreated(
            token,
            msg.sender,
            name,
            symbol,
            TOTAL_SUPPLY,
            VIRTUAL_ETH_RESERVE,
            VIRTUAL_TOKEN_RESERVE,
            MIGRATION_THRESHOLD,
            block.timestamp
        );

        if (msg.value > 0) {
            _buy(token, data, msg.value, 0);
        }
    }

    /// @notice Address the next token created by `creator` would receive.
    function predictTokenAddress(address creator, uint256 index) external view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, _salt(creator, index));
    }

    // ---------------------------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Buy tokens with ETH.
     * @param minTokensOut Slippage floor; revert if fewer tokens would be received.
     * @param deadline     Unix timestamp after which the trade is rejected.
     * @return tokensOut   Tokens transferred to the buyer.
     *
     * @dev A buy that would push the curve past {MIGRATION_THRESHOLD} is partially filled to land
     *      exactly on it, and the unused ETH is refunded — see ECONOMICS §3. Set `minTokensOut`
     *      accordingly: the fill may legitimately be smaller than a naive quote.
     */
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (!isLaunchpadToken[token]) revert UnknownToken();
        if (msg.value == 0) revert ZeroAmount();
        tokensOut = _buy(token, _tokenData[token], msg.value, minTokensOut);
    }

    /**
     * @notice Sell tokens back to the curve for ETH. Requires an ERC-20 approval to this
     *         contract for `tokenAmount`.
     * @param minEthOut Slippage floor, compared against the **post-fee** amount received.
     * @return ethOut   ETH sent to the seller, i.e. gross curve output minus the 0.30 % fee.
     */
    function sell(address token, uint256 tokenAmount, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (!isLaunchpadToken[token]) revert UnknownToken();
        if (tokenAmount == 0) revert ZeroAmount();

        TokenData storage data = _tokenData[token];
        if (data.status != Status.Trading) revert NotTrading();

        uint256 ethReserve = data.ethReserve;
        uint256 tokenReserve = data.tokenReserve;

        uint256 grossEthOut =
            BondingCurve.getEthOut(tokenAmount, VIRTUAL_ETH_RESERVE + ethReserve, tokenReserve);
        if (grossEthOut == 0) revert ZeroAmount();
        // Guaranteed by the solvency theorem (ECONOMICS §4); an explicit check turns any
        // malformed input into a clear revert rather than an arithmetic panic.
        if (grossEthOut > ethReserve) revert InsufficientCurveLiquidity();

        uint256 fee = (grossEthOut * SELL_FEE_BPS) / BPS_DENOMINATOR;
        ethOut = grossEthOut - fee;
        if (ethOut < minEthOut) revert SlippageExceeded();

        // --- effects ---
        ethReserve -= grossEthOut;
        tokenReserve += tokenAmount;
        data.ethReserve = uint128(ethReserve);
        data.tokenReserve = uint128(tokenReserve);
        data.cumulativeEthOut += uint128(grossEthOut);
        data.cumulativeTokensSold += uint128(tokenAmount);
        accruedFees += fee;

        _emitSold(token, tokenAmount, grossEthOut, fee, ethOut, ethReserve, tokenReserve);

        // --- interactions ---
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        _pushEth(msg.sender, ethOut);
    }

    // ---------------------------------------------------------------------------------------
    // Migration
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Move a graduated token's liquidity to Uniswap V2 and burn the LP tokens.
     * @dev Permissionless: anyone may finalise a token that has reached the threshold, so
     *      migration never depends on protocol operators being online.
     *
     *      Protections (spec §5):
     *        - **Double migration** — status flips to `Migrated` before any external call, and
     *          only `PendingMigration` is accepted, so a second call (re-entrant or later)
     *          reverts.
     *        - **Reentrancy** — `nonReentrant` plus strict checks-effects-interactions.
     *        - **Reserve manipulation** — trading was halted atomically in the buy that crossed
     *          the threshold, so reserves are frozen at exactly 5 ETH before any external code
     *          runs, and the amounts come from storage, not from balances.
     *        - **Unauthorised liquidity removal** — the migrator has no owner and holds no LP;
     *          the LP burn is asserted complete inside the same call.
     */
    function migrate(address token) external nonReentrant {
        if (!isLaunchpadToken[token]) revert UnknownToken();
        TokenData storage data = _tokenData[token];
        if (data.status != Status.PendingMigration) revert MigrationNotReady();

        data.status = Status.Migrated;
        data.migratedAt = uint40(block.timestamp);

        uint256 ethAmount = data.ethReserve;
        uint256 tokenTotal = data.tokenReserve;
        data.ethReserve = 0;
        data.tokenReserve = 0;

        // Size the deposit so the pool opens at exactly the final curve price, and burn the
        // portion that was backed by virtual rather than real ETH (ECONOMICS §6.2):
        //     T_pool = T_final * e / (Ev0 + e)   →   burn fraction = Ev0 / (Ev0 + e) = 1/11.
        uint256 tokensForPool = (tokenTotal * ethAmount) / (VIRTUAL_ETH_RESERVE + ethAmount);
        uint256 tokensToBurn = tokenTotal - tokensForPool;

        if (tokensToBurn > 0) {
            IERC20(token).safeTransfer(BURN_ADDRESS, tokensToBurn);
        }
        IERC20(token).safeTransfer(address(migrator), tokensForPool);

        (
            address pair,
            uint256 ethDeposited,
            uint256 tokenDeposited,
            uint256 lpBurned,
            uint256 extraTokensBurned,
            uint256 ethReturned
        ) = migrator.migrate{value: ethAmount}(token, tokensForPool);

        data.pair = pair;
        // Only non-zero if the pair was pre-seeded and some ETH could not be deposited at the
        // existing ratio. Routed to the fee ledger so it stays inside the accounting invariant
        // rather than becoming untracked balance.
        if (ethReturned > 0) {
            accruedFees += ethReturned;
        }

        emit LiquidityMigrated(
            token,
            pair,
            ethDeposited,
            tokenDeposited,
            tokensToBurn + extraTokensBurned,
            lpBurned,
            block.timestamp
        );
    }

    // ---------------------------------------------------------------------------------------
    // ETH claims & fees
    // ---------------------------------------------------------------------------------------

    /**
     * @notice Withdraw ETH credited after a failed push transfer.
     * @dev Unlike the push path this forwards all remaining gas: it runs in the claimant's own
     *      transaction, so a contract wallet needing more than the push budget can still recover.
     */
    function claimPendingEth() external nonReentrant returns (uint256 amount) {
        amount = pendingEth[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingEth[msg.sender] = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit EthClaimed(msg.sender, amount, block.timestamp);
    }

    /// @notice Send accrued platform fees to {feeRecipient}. Permissionless — the caller cannot
    ///         influence the destination, so there is no reason to gate it.
    function withdrawFees() external nonReentrant returns (uint256 amount) {
        amount = accruedFees;
        if (amount == 0) revert ZeroAmount();
        accruedFees = 0;

        address recipient = feeRecipient;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit FeesWithdrawn(recipient, amount, block.timestamp);
    }

    /// @notice Redirect future fee withdrawals. The owner's only privileged action.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    /// @notice Number of tokens ever launched.
    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Paginated registry read, newest-last. Convenience only — `TokenCreated` remains
    ///         the canonical discovery path.
    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = allTokens.length;
        if (offset >= total) return new address[](0);
        uint256 end = Math.min(offset + limit, total);
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = allTokens[i];
        }
    }

    /// @notice Raw stored state for `token`.
    function getTokenData(address token) external view returns (TokenData memory) {
        if (!isLaunchpadToken[token]) revert UnknownToken();
        return _tokenData[token];
    }

    /// @notice Full derived state for `token` — everything spec §3 requires, in one call.
    function getToken(address token) public view returns (TokenView memory view_) {
        if (!isLaunchpadToken[token]) revert UnknownToken();
        TokenData storage data = _tokenData[token];

        uint256 ethReserve = data.ethReserve;
        uint256 tokenReserve = data.tokenReserve;
        uint256 virtualEthReserve = VIRTUAL_ETH_RESERVE + ethReserve;
        uint256 price = BondingCurve.getSpotPrice(virtualEthReserve, tokenReserve);

        // Tokens sitting in the curve are not circulating; burned tokens never circulate again.
        uint256 circulating =
            TOTAL_SUPPLY - tokenReserve - IERC20(token).balanceOf(BURN_ADDRESS);

        view_ = TokenView({
            token: token,
            creator: data.creator,
            status: data.status,
            name: IPumperToken(token).name(),
            symbol: IPumperToken(token).symbol(),
            totalSupply: TOTAL_SUPPLY,
            circulatingSupply: circulating,
            ethReserve: ethReserve,
            virtualEthReserve: virtualEthReserve,
            tokenReserve: tokenReserve,
            virtualTokenReserve: tokenReserve,
            tokenPrice: price,
            marketCap: (price * circulating) / 1e18,
            fullyDilutedValuation: (price * TOTAL_SUPPLY) / 1e18,
            tokensAvailable: tokenReserve > TOKEN_RESERVE_AT_MIGRATION
                ? tokenReserve - TOKEN_RESERVE_AT_MIGRATION
                : 0,
            migrationProgressBps: (ethReserve * BPS_DENOMINATOR) / MIGRATION_THRESHOLD,
            cumulativeEthIn: data.cumulativeEthIn,
            cumulativeEthOut: data.cumulativeEthOut,
            cumulativeTokensBought: data.cumulativeTokensBought,
            cumulativeTokensSold: data.cumulativeTokensSold,
            createdAt: data.createdAt,
            migratedAt: data.migratedAt,
            pair: data.pair
        });
    }

    /// @notice Batch variant of {getToken} for the discover page.
    function getTokensView(address[] calldata tokens)
        external
        view
        returns (TokenView[] memory views)
    {
        views = new TokenView[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            views[i] = getToken(tokens[i]);
        }
    }

    /**
     * @notice Simulate a buy of `ethIn` wei, including threshold pinning.
     * @return fee           Platform fee taken from the input.
     * @return ethAfterFee   ETH that reaches the curve.
     * @return tokensOut     Tokens the buyer would receive.
     * @return refund        ETH returned because the trade was capped at the threshold.
     * @return priceAfter    Spot price after the trade, wei per whole token.
     * @return triggersMigration Whether this buy graduates the token.
     */
    function quoteBuy(address token, uint256 ethIn)
        external
        view
        returns (
            uint256 fee,
            uint256 ethAfterFee,
            uint256 tokensOut,
            uint256 refund,
            uint256 priceAfter,
            bool triggersMigration
        )
    {
        if (!isLaunchpadToken[token]) revert UnknownToken();
        TokenData storage data = _tokenData[token];
        if (data.status != Status.Trading) revert NotTrading();

        uint256 ethReserve = data.ethReserve;
        uint256 tokenReserve = data.tokenReserve;

        BuyQuote memory quote = _quoteBuyFee(ethIn, ethReserve);
        tokensOut = BondingCurve.getTokensOut(
            quote.netEth, VIRTUAL_ETH_RESERVE + ethReserve, tokenReserve
        );

        ethReserve += quote.netEth;
        tokenReserve -= tokensOut;

        fee = quote.fee;
        ethAfterFee = quote.netEth;
        refund = quote.refund;
        priceAfter = BondingCurve.getSpotPrice(VIRTUAL_ETH_RESERVE + ethReserve, tokenReserve);
        triggersMigration = ethReserve >= MIGRATION_THRESHOLD;
    }

    /**
     * @notice Simulate a sell of `tokensIn` base units.
     * @return grossEthOut ETH released by the curve before the fee.
     * @return fee         0.30 % platform fee.
     * @return ethOut      ETH the seller actually receives.
     * @return priceAfter  Spot price after the trade, wei per whole token.
     */
    function quoteSell(address token, uint256 tokensIn)
        external
        view
        returns (uint256 grossEthOut, uint256 fee, uint256 ethOut, uint256 priceAfter)
    {
        if (!isLaunchpadToken[token]) revert UnknownToken();
        TokenData storage data = _tokenData[token];
        if (data.status != Status.Trading) revert NotTrading();

        uint256 ethReserve = data.ethReserve;
        uint256 tokenReserve = data.tokenReserve;

        grossEthOut =
            BondingCurve.getEthOut(tokensIn, VIRTUAL_ETH_RESERVE + ethReserve, tokenReserve);
        fee = (grossEthOut * SELL_FEE_BPS) / BPS_DENOMINATOR;
        ethOut = grossEthOut - fee;

        ethReserve -= grossEthOut;
        tokenReserve += tokensIn;
        priceAfter = BondingCurve.getSpotPrice(VIRTUAL_ETH_RESERVE + ethReserve, tokenReserve);
    }

    /// @notice Exact amounts a migration would move, for pre-migration UI and indexer assertions.
    function previewMigration(address token)
        external
        view
        returns (uint256 ethToPool, uint256 tokensToPool, uint256 tokensToBurn, uint256 openingPrice)
    {
        if (!isLaunchpadToken[token]) revert UnknownToken();
        TokenData storage data = _tokenData[token];

        ethToPool = data.ethReserve;
        uint256 tokenTotal = data.tokenReserve;
        if (ethToPool == 0 || tokenTotal == 0) return (0, 0, 0, 0);

        tokensToPool = (tokenTotal * ethToPool) / (VIRTUAL_ETH_RESERVE + ethToPool);
        tokensToBurn = tokenTotal - tokensToPool;
        openingPrice = BondingCurve.getSpotPrice(ethToPool, tokensToPool);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _buy(address token, TokenData storage data, uint256 grossEthIn, uint256 minTokensOut)
        private
        returns (uint256 tokensOut)
    {
        if (data.status != Status.Trading) revert NotTrading();

        uint256 ethReserve = data.ethReserve;
        BuyQuote memory quote = _quoteBuyFee(grossEthIn, ethReserve);
        if (quote.netEth == 0) revert ZeroAmount();

        uint256 tokenReserve = data.tokenReserve;
        tokensOut = BondingCurve.getTokensOut(
            quote.netEth, VIRTUAL_ETH_RESERVE + ethReserve, tokenReserve
        );
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        // --- effects ---
        ethReserve += quote.netEth;
        tokenReserve -= tokensOut;
        data.ethReserve = uint128(ethReserve);
        data.tokenReserve = uint128(tokenReserve);
        data.cumulativeEthIn += uint128(quote.netEth);
        data.cumulativeTokensBought += uint128(tokensOut);
        accruedFees += quote.fee;

        // Threshold pinning makes this an exact equality, but `>=` is the safer predicate.
        bool triggered = ethReserve >= MIGRATION_THRESHOLD;
        if (triggered) {
            data.status = Status.PendingMigration;
        }

        _emitBought(token, quote.grossUsed, quote.fee, quote.netEth, tokensOut, ethReserve, tokenReserve);
        if (triggered) {
            emit MigrationTriggered(token, ethReserve, tokenReserve, block.timestamp);
        }

        // --- interactions ---
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        if (quote.refund > 0) {
            emit BuyRefunded(token, msg.sender, quote.refund, block.timestamp);
            _pushEth(msg.sender, quote.refund);
        }
    }

    /**
     * @dev Splits `grossEthIn` into fee / curve input / refund, applying threshold pinning.
     *
     *      Normal case: `fee = 0.20 %` of the input, remainder goes to the curve.
     *
     *      Pinned case: the curve only accepts `MIGRATION_THRESHOLD - ethReserve`, so the gross
     *      amount is re-derived from that headroom (ceiled, so the fee is never under-charged)
     *      and the rest is refunded. The `min` clamp guards the integer edge case where
     *      re-deriving the gross would round above what the buyer actually sent; when it binds,
     *      the effective fee rate is marginally *below* 0.20 %, i.e. in the buyer's favour.
     */
    function _quoteBuyFee(uint256 grossEthIn, uint256 ethReserve)
        private
        pure
        returns (BuyQuote memory quote)
    {
        uint256 fee = (grossEthIn * BUY_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netEth = grossEthIn - fee;

        uint256 headroom = MIGRATION_THRESHOLD - ethReserve;
        if (netEth <= headroom) {
            return BuyQuote({grossUsed: grossEthIn, fee: fee, netEth: netEth, refund: 0});
        }

        netEth = headroom;
        uint256 grossUsed = Math.min(
            grossEthIn,
            Math.ceilDiv(netEth * BPS_DENOMINATOR, BPS_DENOMINATOR - BUY_FEE_BPS)
        );
        return BuyQuote({
            grossUsed: grossUsed,
            fee: grossUsed - netEth,
            netEth: netEth,
            refund: grossEthIn - grossUsed
        });
    }

    /// @dev Split out of {_buy} purely to keep the stack shallow.
    function _emitBought(
        address token,
        uint256 ethIn,
        uint256 fee,
        uint256 netEth,
        uint256 tokensOut,
        uint256 ethReserve,
        uint256 tokenReserve
    ) private {
        uint256 virtualEthReserve = VIRTUAL_ETH_RESERVE + ethReserve;
        emit TokenBought(
            token,
            msg.sender,
            ethIn,
            fee,
            netEth,
            tokensOut,
            BondingCurve.getSpotPrice(virtualEthReserve, tokenReserve),
            ethReserve,
            virtualEthReserve,
            tokenReserve,
            block.timestamp
        );
        if (fee > 0) {
            emit PlatformFeeCollected(token, msg.sender, ACTION_BUY, fee, block.timestamp);
        }
    }

    /// @dev Split out of {sell} purely to keep the stack shallow.
    function _emitSold(
        address token,
        uint256 tokensIn,
        uint256 grossEthOut,
        uint256 fee,
        uint256 ethOut,
        uint256 ethReserve,
        uint256 tokenReserve
    ) private {
        uint256 virtualEthReserve = VIRTUAL_ETH_RESERVE + ethReserve;
        emit TokenSold(
            token,
            msg.sender,
            tokensIn,
            grossEthOut,
            fee,
            ethOut,
            BondingCurve.getSpotPrice(virtualEthReserve, tokenReserve),
            ethReserve,
            virtualEthReserve,
            tokenReserve,
            block.timestamp
        );
        if (fee > 0) {
            emit PlatformFeeCollected(token, msg.sender, ACTION_SELL, fee, block.timestamp);
        }
    }

    /// @dev Gas-bounded push with a pull fallback, so one bad receiver cannot brick a trade.
    function _pushEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: ETH_PUSH_GAS_LIMIT}("");
        if (!ok) {
            pendingEth[to] += amount;
            emit EthCredited(to, amount, block.timestamp);
        }
    }

    function _salt(address creator, uint256 index) private view returns (bytes32) {
        return keccak256(abi.encodePacked(creator, index, block.chainid));
    }

    /// @dev Untracked ETH would break `balance == Σ reserves + fees + Σ pending`, so only the
    ///      migrator returning undeposited funds is allowed in.
    receive() external payable {
        if (msg.sender != address(migrator)) revert DirectEthNotAccepted();
    }
}
