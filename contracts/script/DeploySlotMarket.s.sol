// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {SlotMarket} from "../src/SlotMarket.sol";

interface IInferenceServing {
    struct Service {
        address provider;
        string serviceType;
        string url;
        uint256 inputPrice;
        uint256 outputPrice;
        uint256 updatedAt;
        string model;
        string verifiability;
        string additionalInfo;
        address teeSignerAddress;
        bool teeSignerAcknowledged;
    }

    function getService(address provider) external view returns (Service memory);
}

/**
 * Deploy SlotMarket to 0G Galileo (chain 16602).
 *
 *   cd contracts
 *   set -a; source ../apps/web/.env.market; set +a
 *   forge script script/DeploySlotMarket.s.sol \
 *     --rpc-url og_testnet --broadcast --private-key $ZG_PRIVATE_KEY
 *
 * `zgSigner` is read LIVE from 0G's InferenceServing contract in step 1, so the
 * pinned constant is never guessed — it is whatever 0G itself reports for our
 * grading provider, and anyone can re-check it the same way. Unlike the Hedera
 * deploy this replaces, the read and the deploy happen on the SAME chain, so
 * there is no second provider and no TypeScript wrapper.
 *
 * Amounts are in wei because a forge script cannot parse "0.05" from the
 * environment. The defaults are the ones the demo runs on.
 */
contract DeploySlotMarket is Script {
    address constant INFERENCE_SERVING = 0xa79F4c8311FF93C06b8CfB403690cc987c93F91E;

    function run() external {
        uint256 pk = vm.envUint("ZG_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address provider = vm.envAddress("ZG_PROVIDER");

        console.log("1) reading the TEE signer from 0G (the trust anchor)");
        IInferenceServing.Service memory svc = IInferenceServing(INFERENCE_SERVING).getService(provider);
        require(svc.teeSignerAddress != address(0), "provider has no TEE signer registered");
        console.log("   provider :", provider);
        console.log("   model    :", svc.model);
        console.log("   teeSigner:", svc.teeSignerAddress);

        (string memory pType, string memory pIdentity) = _descriptors(svc.additionalInfo);
        console.log("   descriptor:", string(abi.encodePacked(pType, "/", pIdentity)));

        address settler = vm.envOr("ZG_SETTLER", deployer);
        address treasury = vm.envOr("ZG_TREASURY", deployer);
        uint64 slotDuration = uint64(vm.envOr("SLOT_DURATION_S", uint256(30 minutes)));
        uint64 gradeGrace = uint64(vm.envOr("GRADE_GRACE_S", uint256(150)));
        uint64 noShowGrace = uint64(vm.envOr("NO_SHOW_GRACE_S", uint256(90)));
        uint96 minStake = uint96(vm.envOr("MIN_STAKE_WEI", uint256(0.05 ether)));
        uint88 reward = uint88(vm.envOr("REWARD_PER_EPISODE_WEI", uint256(0.002 ether)));
        uint256 fund = vm.envOr("FUND_REWARDS_WEI", uint256(0.1 ether));

        console.log("2) deploying to chain", block.chainid, "(expect 16602)");
        console.log("   deployer :", deployer);
        console.log("   balance  :", deployer.balance);
        require(deployer.balance > fund, "deployer has no OG - hit faucet.0g.ai first");

        vm.startBroadcast(pk);
        SlotMarket market = new SlotMarket{value: fund}(
            svc.teeSignerAddress,
            pType,
            pIdentity,
            settler,
            treasury,
            slotDuration,
            gradeGrace,
            noShowGrace,
            minStake,
            reward
        );
        vm.stopBroadcast();

        console.log("");
        console.log("DEPLOYED");
        console.log("  address :", address(market));
        console.log("  explorer: https://chainscan-galileo.0g.ai/address/%s", address(market));
        console.log("  settler :", settler, "(hot key: relays starts and verdicts)");
        console.log("  treasury:", treasury);
        console.log("  pool    :", fund);
        console.log("");
        console.log("export ZG_SLOT_MARKET_ADDRESS=%s", address(market));

        // The hot key must not also be able to drain the pool. Say so loudly
        // rather than letting it pass review unnoticed.
        if (treasury == settler) {
            console.log("");
            console.log("WARNING: treasury == settler. The hot key can drain the reward pool.");
            console.log("         Set ZG_TREASURY to a separate address before the demo.");
        }
    }

    /// `additionalInfo` is JSON in practice but is a free-text field in the
    /// registry, so fall back rather than bricking the deploy on it. The probe
    /// is a separate contract because a cheatcode revert is only catchable
    /// across a call boundary, and forge forbids `address(this)` in scripts.
    function _descriptors(string memory additionalInfo) private returns (string memory, string memory) {
        string memory pType = "centralized";
        string memory pIdentity = "aliyun";
        JsonProbe probe = new JsonProbe();
        try probe.parse(additionalInfo, ".ProviderType") returns (string memory v) {
            if (bytes(v).length > 0) pType = v;
        } catch {
            console.log("   (additionalInfo not JSON - using defaults)");
        }
        try probe.parse(additionalInfo, ".ProviderIdentity") returns (string memory v) {
            if (bytes(v).length > 0) pIdentity = v;
        } catch {}
        return (pType, pIdentity);
    }
}

contract JsonProbe {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function parse(string memory json, string memory key) external view returns (string memory) {
        return VM.parseJsonString(json, key);
    }
}
