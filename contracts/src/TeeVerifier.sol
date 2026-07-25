// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Proof of Hands — the one piece of cryptography in this repo, in one place.
 *
 * The grading model runs in a TEE on 0G Compute. Its broker signs every
 * response with a key held inside that enclave, using plain EIP-191
 * personal_sign over an ASCII string:
 *
 *     "<sha256(request)>:<sha256(response)>:<type>:<identity>:<tlsFingerprint>"
 *
 * So any EVM contract can check the attestation with `ecrecover`. The one
 * assumption is `zgSigner`, pinned at deploy from what 0G's InferenceServing
 * contract on Galileo reports for this provider
 * (`getService(provider).teeSignerAddress`) — a single constant anyone can
 * re-check against Galileo in seconds, NOT a per-verdict oracle.
 *
 * What this proves: this exact grading output came out of 0G's TEE.
 * What it does NOT prove: what was asked. The signed request hash is taken
 * over the broker's rewritten upstream body, which cannot be reproduced
 * off-chain. Both limits are stated rather than papered over.
 *
 * Extracted so SlotMarket and TeeAttestation share one implementation instead
 * of three copies of the same digest rebuild.
 */
abstract contract TeeVerifier {
    /// 0G TEE signer for the grading provider, from Galileo getService().
    address public immutable zgSigner;
    /// Provider descriptors that form part of the signed text.
    string public providerType;
    string public providerIdentity;

    constructor(address _zgSigner, string memory _type, string memory _identity) {
        require(_zgSigner != address(0), "zgSigner required");
        zgSigner = _zgSigner;
        providerType = _type;
        providerIdentity = _identity;
    }

    /**
     * Rebuild the exact text the enclave signed and hash it EIP-191 style.
     * `responseBytes` is the raw HTTP body the provider returned; hashing it
     * HERE is what binds a signature to this specific verdict rather than to
     * some other call the same enclave once answered.
     */
    function _teeDigest(
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex
    ) internal view returns (bytes32) {
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
        return keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", _toDecimal(bytes(text).length), text)
        );
    }

    /// Reverts unless 0G's enclave really signed this response.
    function _requireTee(
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex,
        bytes calldata teeSignature
    ) internal view {
        bytes32 digest = _teeDigest(requestHashHex, responseBytes, tlsFingerprintHex);
        require(_recover(digest, teeSignature) == zgSigner, "not signed by 0G TEE");
    }

    /// Read-only mirror of the check, so anyone can dry-run an attestation.
    function verifyAttestation(
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex,
        bytes calldata teeSignature
    ) public view returns (bool) {
        bytes32 digest = _teeDigest(requestHashHex, responseBytes, tlsFingerprintHex);
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
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            out[--digits] = bytes1(uint8(48 + (v % 10)));
        }
        return string(out);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "bad signature");
        return recovered;
    }
}
