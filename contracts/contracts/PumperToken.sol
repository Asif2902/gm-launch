// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title PumperToken
 * @notice The single, standardised ERC-20 implementation behind every Pumper launch.
 *
 * @dev Deployed once and reused for every token via EIP-1167 minimal proxies
 *      ({Clones.cloneDeterministic}), so all launches share byte-identical logic and the
 *      indexer never needs token-specific handling.
 *
 *      Deliberate non-features (spec §10) — this contract has:
 *        - no owner, no admin, no upgrade path (clones point at a fixed implementation);
 *        - no `mint` after {initialize}; supply is fixed at 1,000,000,000 * 1e18 forever;
 *        - no transfer hooks, taxes or fee-on-transfer behaviour (`_update` is not overridden);
 *        - no blacklist, pause, or balance-modifying function of any kind;
 *        - no trading restriction that could act as a honeypot — transfers are unrestricted
 *          from block one, including before the curve migrates.
 *
 *      Anyone can independently verify these properties: the implementation address is
 *      immutable on the factory and every clone is 45 bytes of EIP-1167 pointing at it.
 */
contract PumperToken is ERC20Upgradeable {
    /// @notice Fixed supply for every Pumper token: 1 billion, 18 decimals.
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    /// @notice The launchpad that created this token and seeded the bonding curve.
    address public launchpad;

    /// @notice The address that submitted the creation transaction. Purely informational —
    ///         it carries no permissions whatsoever.
    address public creator;

    error AlreadyInitialized();

    constructor() {
        // Lock the implementation so it can never be initialised directly; only clones are usable.
        _disableInitializers();
    }

    /**
     * @notice One-time setup, called by the factory in the same transaction as the clone deploy.
     * @dev Mints the entire fixed supply to `launchpad_`, which holds it as bonding-curve
     *      inventory. There is no code path that mints again — {ERC20Upgradeable-_mint} is not
     *      reachable from any other function in this contract.
     */
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address creator_,
        address launchpad_
    ) external initializer {
        __ERC20_init(name_, symbol_);
        creator = creator_;
        launchpad = launchpad_;
        _mint(launchpad_, MAX_SUPPLY);
    }
}
