// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The only part of {PumperToken} the factory needs, kept minimal so the factory does
///         not carry the token's bytecode.
interface IPumperToken {
    function initialize(
        string calldata name,
        string calldata symbol,
        address creator,
        address launchpad
    ) external;

    function name() external view returns (string memory);

    function symbol() external view returns (string memory);
}
