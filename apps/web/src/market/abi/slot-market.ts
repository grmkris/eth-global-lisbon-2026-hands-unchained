/**
 * GENERATED — do not edit. Run `bun run contracts:abi` after changing
 * contracts/src/SlotMarket.sol.
 *
 * Committed on purpose: contracts/ is not in the production Docker image, so
 * this file is the hub's and the browser's only route to the ABI. See
 * apps/web/scripts/sync-abi.ts for why.
 */
export const slotMarketAbi = [
	{
		type: "constructor",
		inputs: [
			{
				name: "_zgSigner",
				type: "address",
				internalType: "address",
			},
			{
				name: "_registry",
				type: "address",
				internalType: "address",
			},
			{
				name: "_provider",
				type: "address",
				internalType: "address",
			},
			{
				name: "_type",
				type: "string",
				internalType: "string",
			},
			{
				name: "_identity",
				type: "string",
				internalType: "string",
			},
			{
				name: "_settler",
				type: "address",
				internalType: "address",
			},
			{
				name: "_treasury",
				type: "address",
				internalType: "address",
			},
			{
				name: "_slotDuration",
				type: "uint64",
				internalType: "uint64",
			},
			{
				name: "_gradeGrace",
				type: "uint64",
				internalType: "uint64",
			},
			{
				name: "_noShowGrace",
				type: "uint64",
				internalType: "uint64",
			},
			{
				name: "_minStake",
				type: "uint96",
				internalType: "uint96",
			},
			{
				name: "_rewardPerEpisode",
				type: "uint88",
				internalType: "uint88",
			},
		],
		stateMutability: "payable",
	},
	{
		type: "receive",
		stateMutability: "payable",
	},
	{
		type: "function",
		name: "MAX_STRIKES",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint8",
				internalType: "uint8",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "attestationUsed",
		inputs: [
			{
				name: "",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [
			{
				name: "",
				type: "bool",
				internalType: "bool",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "bookSlot",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "pinHash",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "payable",
	},
	{
		type: "function",
		name: "cancel",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "currentSlot",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "drainPool",
		inputs: [
			{
				name: "amount",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "endEarly",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "episodeSeen",
		inputs: [
			{
				name: "",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [
			{
				name: "",
				type: "bool",
				internalType: "bool",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "fundRewards",
		inputs: [],
		outputs: [],
		stateMutability: "payable",
	},
	{
		type: "function",
		name: "gradeGrace",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint64",
				internalType: "uint64",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "liveSlotOf",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "op",
				type: "address",
				internalType: "address",
			},
		],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "minStake",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint96",
				internalType: "uint96",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "nextSlotId",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "noShowGrace",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint64",
				internalType: "uint64",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "owed",
		inputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "owner",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "providerIdentity",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "string",
				internalType: "string",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "providerType",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "string",
				internalType: "string",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "queueAt",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "offset",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "queueLength",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "recordEpisode",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
			{
				name: "episodeId",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "score",
				type: "uint16",
				internalType: "uint16",
			},
			{
				name: "pass",
				type: "bool",
				internalType: "bool",
			},
			{
				name: "claimedSuccess",
				type: "bool",
				internalType: "bool",
			},
			{
				name: "storageRoot",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "requestHashHex",
				type: "string",
				internalType: "string",
			},
			{
				name: "responseBytes",
				type: "bytes",
				internalType: "bytes",
			},
			{
				name: "tlsFingerprintHex",
				type: "string",
				internalType: "string",
			},
			{
				name: "teeSignature",
				type: "bytes",
				internalType: "bytes",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "recordEpisodeUnattested",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
			{
				name: "episodeId",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "score",
				type: "uint16",
				internalType: "uint16",
			},
			{
				name: "pass",
				type: "bool",
				internalType: "bool",
			},
			{
				name: "claimedSuccess",
				type: "bool",
				internalType: "bool",
			},
			{
				name: "storageRoot",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "refreshSigner",
		inputs: [],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "rewardPerEpisode",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint88",
				internalType: "uint88",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "rewardPool",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "rigQueue",
		inputs: [
			{
				name: "",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [
			{
				name: "head",
				type: "uint32",
				internalType: "uint32",
			},
			{
				name: "headSince",
				type: "uint64",
				internalType: "uint64",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "setOwner",
		inputs: [
			{
				name: "o",
				type: "address",
				internalType: "address",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "setSettler",
		inputs: [
			{
				name: "s",
				type: "address",
				internalType: "address",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "setTreasury",
		inputs: [
			{
				name: "t",
				type: "address",
				internalType: "address",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "settle",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "settler",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "signerProvider",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "signerRegistry",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "skipHead",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "slotDuration",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint64",
				internalType: "uint64",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "slots",
		inputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "operator",
				type: "address",
				internalType: "address",
			},
			{
				name: "stake",
				type: "uint96",
				internalType: "uint96",
			},
			{
				name: "pinHash",
				type: "bytes32",
				internalType: "bytes32",
			},
			{
				name: "bookedAt",
				type: "uint40",
				internalType: "uint40",
			},
			{
				name: "startedAt",
				type: "uint40",
				internalType: "uint40",
			},
			{
				name: "endAt",
				type: "uint40",
				internalType: "uint40",
			},
			{
				name: "accrued",
				type: "uint88",
				internalType: "uint88",
			},
			{
				name: "passes",
				type: "uint16",
				internalType: "uint16",
			},
			{
				name: "episodes",
				type: "uint16",
				internalType: "uint16",
			},
			{
				name: "strikes",
				type: "uint8",
				internalType: "uint8",
			},
			{
				name: "status",
				type: "uint8",
				internalType: "enum SlotMarket.Status",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "stakedTotal",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "uint256",
				internalType: "uint256",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "startSlot",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				internalType: "uint256",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "sweep",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				internalType: "bytes32",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "treasury",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "verifyAttestation",
		inputs: [
			{
				name: "requestHashHex",
				type: "string",
				internalType: "string",
			},
			{
				name: "responseBytes",
				type: "bytes",
				internalType: "bytes",
			},
			{
				name: "tlsFingerprintHex",
				type: "string",
				internalType: "string",
			},
			{
				name: "teeSignature",
				type: "bytes",
				internalType: "bytes",
			},
		],
		outputs: [
			{
				name: "",
				type: "bool",
				internalType: "bool",
			},
		],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "withdraw",
		inputs: [
			{
				name: "payee",
				type: "address",
				internalType: "address",
			},
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "zgSigner",
		inputs: [],
		outputs: [
			{
				name: "",
				type: "address",
				internalType: "address",
			},
		],
		stateMutability: "view",
	},
	{
		type: "event",
		name: "EpisodeRecorded",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "episodeId",
				type: "bytes32",
				indexed: true,
				internalType: "bytes32",
			},
			{
				name: "score",
				type: "uint16",
				indexed: false,
				internalType: "uint16",
			},
			{
				name: "pass",
				type: "bool",
				indexed: false,
				internalType: "bool",
			},
			{
				name: "claimedSuccess",
				type: "bool",
				indexed: false,
				internalType: "bool",
			},
			{
				name: "attested",
				type: "bool",
				indexed: false,
				internalType: "bool",
			},
			{
				name: "storageRoot",
				type: "bytes32",
				indexed: false,
				internalType: "bytes32",
			},
			{
				name: "reward",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "HeadChanged",
		inputs: [
			{
				name: "rigId",
				type: "bytes32",
				indexed: true,
				internalType: "bytes32",
			},
			{
				name: "slotId",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "Paid",
		inputs: [
			{
				name: "to",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "amount",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "RewardPoolDry",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "wanted",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "RewardsFunded",
		inputs: [
			{
				name: "from",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "amount",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
			{
				name: "pool",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SettlerChanged",
		inputs: [
			{
				name: "settler",
				type: "address",
				indexed: false,
				internalType: "address",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SignerRefreshed",
		inputs: [
			{
				name: "from",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "to",
				type: "address",
				indexed: true,
				internalType: "address",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotBooked",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "rigId",
				type: "bytes32",
				indexed: true,
				internalType: "bytes32",
			},
			{
				name: "operator",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "stake",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
			{
				name: "position",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
			{
				name: "pinHash",
				type: "bytes32",
				indexed: false,
				internalType: "bytes32",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotCancelled",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "operator",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "refund",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotEndedEarly",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "endAt",
				type: "uint64",
				indexed: false,
				internalType: "uint64",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotSettled",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "operator",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "stakeBack",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
			{
				name: "reward",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
			{
				name: "passes",
				type: "uint16",
				indexed: false,
				internalType: "uint16",
			},
			{
				name: "strikes",
				type: "uint8",
				indexed: false,
				internalType: "uint8",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotSkipped",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "operator",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "refund",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotStarted",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "rigId",
				type: "bytes32",
				indexed: true,
				internalType: "bytes32",
			},
			{
				name: "endAt",
				type: "uint64",
				indexed: false,
				internalType: "uint64",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "SlotVoided",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "operator",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "slashed",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
			{
				name: "forfeited",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "Strike",
		inputs: [
			{
				name: "slotId",
				type: "uint256",
				indexed: true,
				internalType: "uint256",
			},
			{
				name: "operator",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "strikes",
				type: "uint8",
				indexed: false,
				internalType: "uint8",
			},
		],
		anonymous: false,
	},
	{
		type: "event",
		name: "Withdrawn",
		inputs: [
			{
				name: "to",
				type: "address",
				indexed: true,
				internalType: "address",
			},
			{
				name: "amount",
				type: "uint256",
				indexed: false,
				internalType: "uint256",
			},
		],
		anonymous: false,
	},
] as const;
