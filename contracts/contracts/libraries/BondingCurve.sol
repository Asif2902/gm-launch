// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title BondingCurve
 * @notice Pure constant-product math for the Pumper launchpad: `E * T = k`.
 *
 * @dev `ethReserve` here is always the **effective** (virtual) ETH reserve
 *      `E = VIRTUAL_ETH_RESERVE + realEthReserve`, and `tokenReserve` is `T`, the curve's
 *      actual token balance. The library is stateless and holds no `k`: `k` is implied by the
 *      reserves and re-derived on every call, so rounding can never accumulate.
 *
 *      Every rounding decision is documented in docs/ECONOMICS.md §8. Buy/sell outputs are
 *      floored (dust stays with the curve, so `E*T` weakly increases and the curve can never
 *      become insolvent); the inverse quotes are ceiled so a caller is never under-charged.
 */
library BondingCurve {
    /// @dev Price is quoted in wei per *whole* token; this converts base units to whole tokens.
    uint256 internal constant PRICE_UNIT = 1e18;

    error InsufficientLiquidity();

    /**
     * @notice Tokens received for `ethIn` (post-fee ETH) against reserves `(E, T)`.
     * @dev Algebraically `T - k/(E+ethIn)`, written as `T*ethIn/(E+ethIn)` to avoid needing `k`.
     *      Floored.
     */
    function getTokensOut(uint256 ethIn, uint256 ethReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (ethIn == 0) return 0;
        return (tokenReserve * ethIn) / (ethReserve + ethIn);
    }

    /**
     * @notice Gross ETH released for `tokensIn` against reserves `(E, T)`, before the sell fee.
     * @dev Algebraically `E - k/(T+tokensIn)`, written as `E*tokensIn/(T+tokensIn)`. Floored.
     */
    function getEthOut(uint256 tokensIn, uint256 ethReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (tokensIn == 0) return 0;
        return (ethReserve * tokensIn) / (tokenReserve + tokensIn);
    }

    /**
     * @notice Post-fee ETH required to buy exactly `tokensDesired`. Ceiled.
     * @dev Inverse of {getTokensOut}: `E*d/(T-d)`. Quote helper for the UI; the trade path
     *      itself never calls this.
     */
    function getEthInForTokensOut(uint256 tokensDesired, uint256 ethReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (tokensDesired == 0) return 0;
        if (tokensDesired >= tokenReserve) revert InsufficientLiquidity();
        uint256 numerator = ethReserve * tokensDesired;
        uint256 denominator = tokenReserve - tokensDesired;
        return _ceilDiv(numerator, denominator);
    }

    /**
     * @notice Tokens that must be sold to release exactly `grossEthDesired` before the sell fee.
     *         Ceiled.
     * @dev Inverse of {getEthOut}: `T*g/(E-g)`.
     */
    function getTokensInForEthOut(uint256 grossEthDesired, uint256 ethReserve, uint256 tokenReserve)
        internal
        pure
        returns (uint256)
    {
        if (grossEthDesired == 0) return 0;
        if (grossEthDesired >= ethReserve) revert InsufficientLiquidity();
        uint256 numerator = tokenReserve * grossEthDesired;
        uint256 denominator = ethReserve - grossEthDesired;
        return _ceilDiv(numerator, denominator);
    }

    /**
     * @notice Spot price in wei per whole token: `P = E * 1e18 / T`.
     * @dev Equivalent closed form used by the indexer as a cross-check: `P = E^2 * 1e18 / k`.
     */
    function getSpotPrice(uint256 ethReserve, uint256 tokenReserve) internal pure returns (uint256) {
        if (tokenReserve == 0) return 0;
        return (ethReserve * PRICE_UNIT) / tokenReserve;
    }

    /**
     * @notice Valuation of `totalSupply` base units at spot price, in wei.
     * @dev With the full supply this is the FDV; with the circulating supply, the market cap.
     */
    function getValuation(uint256 ethReserve, uint256 tokenReserve, uint256 totalSupply)
        internal
        pure
        returns (uint256)
    {
        return (getSpotPrice(ethReserve, tokenReserve) * totalSupply) / PRICE_UNIT;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
