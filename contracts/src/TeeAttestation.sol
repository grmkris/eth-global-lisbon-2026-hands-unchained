// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TeeVerifier} from "./TeeVerifier.sol";

/**
 * Hands Unchained — the bridge between 0G's referee and Hedera's money.
 *
 * The grading model runs in a TEE on 0G Compute; its broker signs every
 * response inside the enclave with plain EIP-191. That means a contract on ANY
 * EVM chain can verify the attestation with ecrecover — including Hedera,
 * which cannot read 0G's registry. See TeeVerifier for the mechanism, the
 * trust anchor and its honest limits.
 *
 * STATUS: dormant. The market layer now settles on 0G itself (SlotMarket.sol),
 * where the same verification decides payment and slashing directly instead of
 * being carried to another chain. This contract stays deployed and compiling
 * because it is the cross-chain deliverable — setting the Hedera env brings it
 * back in one redeploy. Do not "clean it up".
 */
contract TeeAttestation is TeeVerifier {
    event Graded(
        bytes32 indexed attemptId,
        bytes32 indexed operator,
        uint16 score,
        bool pass,
        bytes32 responseHash,
        string chatID,
        uint256 ts
    );

    constructor(
        address _zgSigner,
        address _registry,
        address _provider,
        string memory _type,
        string memory _identity
    ) TeeVerifier(_zgSigner, _registry, _provider, _type, _identity) {}

    /**
     * Record a grade only if 0G's TEE really signed the response it came from.
     * `responseBytes` is the exact HTTP body the provider returned; hashing it
     * inside the verifier is what binds the signature to this specific verdict
     * rather than to some other call.
     */
    function recordGrade(
        bytes32 attemptId,
        bytes32 operator,
        uint16 score,
        bool pass,
        string calldata chatID,
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex,
        bytes calldata teeSignature
    ) external {
        _requireTee(requestHashHex, responseBytes, tlsFingerprintHex, teeSignature);
        emit Graded(
            attemptId, operator, score, pass, sha256(responseBytes), chatID, block.timestamp
        );
    }

    /**
     * Read-only mirror of the check, so anyone can dry-run an attestation.
     * Kept under this name because the already-deployed ABI and the hub's
     * client (`apps/web/src/market/tee-bridge.ts:18`) both spell it `verify`.
     */
    function verify(
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex,
        bytes calldata teeSignature
    ) external view returns (bool) {
        return verifyAttestation(requestHashHex, responseBytes, tlsFingerprintHex, teeSignature);
    }
}
