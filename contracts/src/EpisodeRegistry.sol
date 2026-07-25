// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Proof of Hands — on-chain provenance for graded teleoperation episodes.
/// Event-only by design: the durable record IS the event log; nothing to
/// upgrade, nothing to get wrong. One `record` per graded attempt, emitted
/// by the hub's settlement worker on 0G Galileo (chain 16602).
contract EpisodeRegistry {
    event Episode(
        bytes32 indexed episodeHash, // hash of attemptId|rig|taskId
        bytes32 indexed operator, // hash of the operator's World ID nullifier
        uint16 score, // referee score 0-100 (0G Compute grade)
        bool pass, // referee verdict
        bytes32 storageRoot, // 0G Storage root of {telemetry, verdict, frame}
        uint256 ts
    );

    function record(
        bytes32 episodeHash,
        bytes32 operator,
        uint16 score,
        bool pass,
        bytes32 storageRoot
    ) external {
        emit Episode(episodeHash, operator, score, pass, storageRoot, block.timestamp);
    }
}
