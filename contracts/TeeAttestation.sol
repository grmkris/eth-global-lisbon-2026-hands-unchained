// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Proof of Hands — the bridge between 0G's referee and Hedera's money.
 *
 * The grading model runs in a TEE on 0G Compute. Its broker signs every
 * response with a key held inside that enclave, using plain EIP-191
 * personal_sign over an ASCII string:
 *
 *     "<sha256(request)>:<sha256(response)>:<type>:<identity>:<tlsFingerprint>"
 *
 * That means a contract on ANY EVM chain can verify the attestation with
 * ecrecover — including Hedera, which cannot read 0G's registry. The one
 * cross-chain assumption is `zgSigner`, pinned at deploy from what 0G's
 * InferenceServing contract on Galileo reports for this provider
 * (`getService(provider).teeSignerAddress`). It is a single constant anyone
 * can audit against Galileo in seconds — NOT a per-verdict oracle.
 *
 * What this proves: this exact grading output came out of 0G's TEE.
 * What it does NOT prove: what was asked. The signed request hash is taken
 * over the broker's rewritten upstream body, which cannot be reproduced
 * off-chain, and our backend still chooses which graded attempt to submit.
 * Both limits are stated rather than papered over.
 */
contract TeeAttestation {
    /// 0G TEE signer for the grading provider, from Galileo getService().
    address public immutable zgSigner;
    /// Provider descriptors that form part of the signed text.
    string public providerType;
    string public providerIdentity;

    event Graded(
        bytes32 indexed attemptId,
        bytes32 indexed operator,
        uint16 score,
        bool pass,
        bytes32 responseHash,
        string chatID,
        uint256 ts
    );

    constructor(address _zgSigner, string memory _type, string memory _identity) {
        zgSigner = _zgSigner;
        providerType = _type;
        providerIdentity = _identity;
    }

    /**
     * Record a grade only if 0G's TEE really signed the response it came
     * from. `responseBytes` is the exact HTTP body the provider returned;
     * hashing it here is what binds the signature to this specific verdict
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
        string memory text = string(
            abi.encodePacked(
                requestHashHex,
                ":",
                _toHex(sha256(responseBytes)),
                ":",
                providerType,
                ":",
                providerIdentity,
                ":",
                tlsFingerprintHex
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n",
                _toDecimal(bytes(text).length),
                text
            )
        );
        require(_recover(digest, teeSignature) == zgSigner, "not signed by 0G TEE");

        emit Graded(
            attemptId,
            operator,
            score,
            pass,
            sha256(responseBytes),
            chatID,
            block.timestamp
        );
    }

    /// Read-only mirror of the check, so anyone can dry-run an attestation.
    function verify(
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex,
        bytes calldata teeSignature
    ) external view returns (bool) {
        string memory text = string(
            abi.encodePacked(
                requestHashHex,
                ":",
                _toHex(sha256(responseBytes)),
                ":",
                providerType,
                ":",
                providerIdentity,
                ":",
                tlsFingerprintHex
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n",
                _toDecimal(bytes(text).length),
                text
            )
        );
        return _recover(digest, teeSignature) == zgSigner;
    }

    function _toHex(bytes32 value) private pure returns (string memory) {
        bytes memory symbols = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            out[i * 2] = symbols[uint8(value[i]) >> 4];
            out[i * 2 + 1] = symbols[uint8(value[i]) & 0x0f];
        }
        return string(out);
    }

    function _toDecimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) ++digits;
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) out[--digits] = bytes1(uint8(48 + (v % 10)));
        return string(out);
    }

    function _recover(bytes32 digest, bytes memory sig) private pure returns (address) {
        require(sig.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "bad signature");
        return recovered;
    }
}
