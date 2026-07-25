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
    uint256 constant OG_GALILEO = 16602;

    function run() external {
        // DEPLOY_KEY lets a chain bring its own funded deployer; 0G and Hedera
        // do not share a wallet with HBAR in it.
        uint256 pk = vm.envOr("DEPLOY_KEY", vm.envUint("ZG_PRIVATE_KEY"));
        address deployer = vm.addr(pk);
        address provider = vm.envAddress("ZG_PROVIDER");

        // Where the trust anchor comes from depends on where we are deploying.
        // On 0G the registry is right there, so read it and let the contract
        // keep reading it. Anywhere else there is nothing to read, so the
        // signer must be supplied and becomes a pinned constant — which is
        // exactly the single cross-chain assumption we document.
        address zgSigner;
        string memory pType;
        string memory pIdentity;
        address registry;

        if (block.chainid == OG_GALILEO) {
            console.log("1) reading the TEE signer LIVE from 0G (same chain)");
            IInferenceServing.Service memory svc =
                IInferenceServing(INFERENCE_SERVING).getService(provider);
            require(svc.teeSignerAddress != address(0), "provider has no TEE signer registered");
            zgSigner = svc.teeSignerAddress;
            (pType, pIdentity) = _descriptors(svc.additionalInfo);
            registry = INFERENCE_SERVING;
            console.log("   model    :", svc.model);
        } else {
            console.log("1) 0G's registry is not reachable from this chain - pinning");
            zgSigner = vm.envAddress("ZG_SIGNER");
            pType = vm.envOr("ZG_PROVIDER_TYPE", string("centralized"));
            pIdentity = vm.envOr("ZG_PROVIDER_IDENTITY", string("aliyun"));
            registry = address(0);
            require(zgSigner != address(0), "ZG_SIGNER required off 0G");
        }
        console.log("   provider :", provider);
        console.log("   teeSigner:", zgSigner);
        console.log("   descriptor:", string(abi.encodePacked(pType, "/", pIdentity)));

        address settler = vm.envOr("ZG_SETTLER", deployer);
        address treasury = vm.envOr("ZG_TREASURY", deployer);
        uint64 slotDuration = uint64(vm.envOr("SLOT_DURATION_S", uint256(30 minutes)));
        uint64 gradeGrace = uint64(vm.envOr("GRADE_GRACE_S", uint256(150)));
        uint64 noShowGrace = uint64(vm.envOr("NO_SHOW_GRACE_S", uint256(90)));
        uint96 minStake = uint96(vm.envOr("MIN_STAKE_WEI", uint256(0.05 ether)));
        uint88 reward = uint88(vm.envOr("REWARD_PER_EPISODE_WEI", uint256(0.002 ether)));
        uint256 fund = vm.envOr("FUND_REWARDS_WEI", uint256(0.1 ether));

        console.log("2) deploying to chain", block.chainid);
        console.log("   deployer :", deployer);
        console.log("   balance  :", deployer.balance);
        require(
            deployer.balance > fund,
            block.chainid == OG_GALILEO
                ? "deployer has no OG - hit faucet.0g.ai first"
                : "deployer has too little native token for the pool plus gas"
        );

        vm.startBroadcast(pk);
        SlotMarket market = new SlotMarket{value: fund}(
            zgSigner,
            registry,
            provider,
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
        console.log("  explorer:", address(market));
        console.log("  settler :", settler, "(hot key: relays starts and verdicts)");
        console.log("  treasury:", treasury);
        // UNITS ARE NOT THE SAME ON BOTH CHAINS and getting this wrong is
        // silent: Hedera's EVM denominates value in TINYBAR (1e8 = 1 HBAR) and
        // the JSON-RPC relay divides the weibar a wallet sends by 1e10. Pass
        // 5e17 here expecting "0.5" and you have set a stake of five billion
        // HBAR that nobody can ever pay. Print the interpretation so a wrong
        // number is obvious in the deploy log rather than at the first booking.
        console.log("  pool    :", fund);
        console.log(
            "  units   :",
            block.chainid == OG_GALILEO ? "wei (1e18 = 1 OG)" : "TINYBAR (1e8 = 1 HBAR)"
        );
        console.log("  stake   :", minStake);
        console.log("  reward  :", reward);
        console.log(
            "  anchor  :",
            registry == address(0)
                ? "PINNED (audit against 0G with one call)"
                : "LIVE from 0G InferenceServing"
        );
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
    function _descriptors(string memory additionalInfo)
        private
        returns (string memory, string memory)
    {
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
