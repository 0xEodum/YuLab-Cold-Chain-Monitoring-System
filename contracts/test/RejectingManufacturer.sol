// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ColdChain} from "../ColdChain.sol";

/// @dev Test helper: a manufacturer contract that refuses incoming ETH, used to exercise
///      the TransferFailed path of ColdChain.withdraw().
contract RejectingManufacturer {
    ColdChain public immutable coldChain;

    constructor(ColdChain coldChain_) {
        coldChain = coldChain_;
    }

    function createAndCancel(address carrier, address receiver, address sensor) external payable {
        uint256 id = coldChain.createShipment{value: msg.value}("test", carrier, receiver, sensor, 20, 80, 0);
        coldChain.cancelShipment(id);
    }

    function withdraw() external {
        coldChain.withdraw();
    }

    receive() external payable {
        revert("no ETH accepted");
    }
}
