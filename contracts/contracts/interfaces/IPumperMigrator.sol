// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @notice The migration boundary: everything the launchpad knows about Uniswap.
 * @dev Keeping the AMM interaction behind this interface is what lets the launchpad remain
 *      free of external-protocol assumptions (spec §12: separate migration and Uniswap V2
 *      interaction). The launchpad transfers the pool tokens to the migrator, calls
 *      {migrate} with the ETH attached, and records what comes back.
 */
interface IPumperMigrator {
    /// @notice The launchpad this migrator is bound to. The launchpad's constructor asserts
    ///         this equals its own address, so the two-way wiring cannot be misconfigured.
    function launchpad() external view returns (address);

    /**
     * @param token       The Pumper token being migrated.
     * @param tokenAmount Tokens the launchpad has already transferred to this contract.
     *
     * @return pair          The Uniswap V2 pair holding the new liquidity.
     * @return ethDeposited  ETH actually added as liquidity.
     * @return tokenDeposited Tokens actually added as liquidity.
     * @return lpBurned      LP tokens minted and then permanently burned.
     * @return tokensBurned  Tokens that could not be deposited and were burned instead
     *                       (non-zero only in the pre-seeded-pair edge case).
     * @return ethReturned   ETH that could not be deposited and was returned to the launchpad
     *                       (non-zero only in the pre-seeded-pair edge case).
     */
    function migrate(address token, uint256 tokenAmount)
        external
        payable
        returns (
            address pair,
            uint256 ethDeposited,
            uint256 tokenDeposited,
            uint256 lpBurned,
            uint256 tokensBurned,
            uint256 ethReturned
        );
}
