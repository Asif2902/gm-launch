// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPumperFactoryTest {
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        returns (uint256);

    function sell(address token, uint256 tokenAmount, uint256 minEthOut, uint256 deadline)
        external
        returns (uint256);

    function migrate(address token) external;

    function claimPendingEth() external returns (uint256);

    function pendingEth(address account) external view returns (uint256);
}

/// @notice Rejects every incoming ETH transfer — exercises the push-fails/credit-pending path.
contract RevertingReceiver {
    IPumperFactoryTest public immutable factory;
    bool public acceptEth;

    constructor(address factory_) {
        factory = IPumperFactoryTest(factory_);
    }

    function setAcceptEth(bool value) external {
        acceptEth = value;
    }

    function buy(address token, uint256 minTokensOut) external payable {
        factory.buy{value: msg.value}(token, minTokensOut, type(uint256).max);
    }

    function sell(address token, uint256 amount) external {
        IERC20(token).approve(address(factory), amount);
        factory.sell(token, amount, 0, type(uint256).max);
    }

    function claim() external {
        factory.claimPendingEth();
    }

    receive() external payable {
        require(acceptEth, "RevertingReceiver: ETH rejected");
    }
}

/// @notice Burns far more gas than the push budget allows, forcing the pull fallback without
///         reverting outright.
contract GasGuzzlingReceiver {
    IPumperFactoryTest public immutable factory;
    uint256 public sink;

    constructor(address factory_) {
        factory = IPumperFactoryTest(factory_);
    }

    function buy(address token) external payable {
        factory.buy{value: msg.value}(token, 0, type(uint256).max);
    }

    function sell(address token, uint256 amount) external {
        IERC20(token).approve(address(factory), amount);
        factory.sell(token, amount, 0, type(uint256).max);
    }

    receive() external payable {
        for (uint256 i = 0; i < 5_000; ++i) {
            sink = sink + i;
        }
    }
}

/// @notice Attempts to re-enter the launchpad from the ETH callback of a sell or a buy refund.
contract ReentrancyAttacker {
    IPumperFactoryTest public immutable factory;
    address public token;
    uint8 public mode; // 0 = off, 1 = re-enter buy, 2 = re-enter sell, 3 = re-enter migrate
    bool public reentered;
    bool public reentryReverted;

    constructor(address factory_) {
        factory = IPumperFactoryTest(factory_);
    }

    function arm(address token_, uint8 mode_) external {
        token = token_;
        mode = mode_;
        reentered = false;
        reentryReverted = false;
    }

    function buy(address token_, uint256 value) external payable {
        factory.buy{value: value}(token_, 0, type(uint256).max);
    }

    function sell(address token_, uint256 amount) external {
        IERC20(token_).approve(address(factory), amount);
        factory.sell(token_, amount, 0, type(uint256).max);
    }

    receive() external payable {
        if (mode == 0 || reentered) return;
        reentered = true;

        if (mode == 1) {
            try factory.buy{value: 1 wei}(token, 0, type(uint256).max) returns (uint256) {}
            catch {
                reentryReverted = true;
            }
        } else if (mode == 2) {
            try factory.sell(token, 1e18, 0, type(uint256).max) returns (uint256) {}
            catch {
                reentryReverted = true;
            }
        } else if (mode == 3) {
            try factory.migrate(token) {}
            catch {
                reentryReverted = true;
            }
        }
    }
}
