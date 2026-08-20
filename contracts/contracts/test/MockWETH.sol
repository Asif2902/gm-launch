// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockWETH
 * @notice Faithful WETH9 reimplementation for local tests.
 * @dev Mirrors the canonical WETH9 semantics the migrator depends on: `deposit` mints 1:1,
 *      `withdraw` burns 1:1, and `transfer`/`transferFrom` return `true`. On Base Sepolia the
 *      real WETH at 0x4200000000000000000000000000000000000006 is used instead.
 */
contract MockWETH {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed to, uint256 value);
    event Withdrawal(address indexed from, uint256 value);

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 value) external {
        require(balanceOf[msg.sender] >= value, "WETH: insufficient balance");
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        (bool ok,) = msg.sender.call{value: value}("");
        require(ok, "WETH: ETH transfer failed");
        emit Withdrawal(msg.sender, value);
        emit Transfer(msg.sender, address(0), value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return transferFrom(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        require(balanceOf[from] >= value, "WETH: insufficient balance");
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= value, "WETH: insufficient allowance");
            allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }

    receive() external payable {
        deposit();
    }
}
