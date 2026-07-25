// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TeeVerifier} from "./TeeVerifier.sol";

/**
 * Proof of Hands — the slot market. Entirely on 0G Galileo (chain 16602).
 *
 * A rig is rented in exclusive slots. You stake OG to book; if the rig is busy
 * you join an on-chain FIFO queue behind whoever holds it. Your clock does not
 * start when you book — it starts when you first UNLOCK the rig with your PIN,
 * so a slot you booked and never walked up to costs you nothing and costs the
 * queue only the no-show grace.
 *
 * Every episode you drive is graded by a model running in a TEE on 0G Compute.
 * This contract rebuilds the enclave's signed text from the raw response bytes
 * and `ecrecover`s it (see TeeVerifier). A verified pass credits you from the
 * reward pool. A verified FAIL on an episode you CLAIMED was a success is a
 * strike; the third strike voids your slot on the spot.
 *
 * Only `settler` (the hub) may submit a verdict, but the signature is checked
 * HERE. So the hub can choose WHICH verdict to submit and can never FORGE one.
 * That is the whole mechanism. Its honest limits:
 *
 *   - It proves this exact grading output came out of 0G's TEE. It does NOT
 *     prove what was asked: 0G signs a hash of the broker's rewritten upstream
 *     body, which cannot be reproduced off-chain.
 *   - `score` and `pass` arrive as calldata rather than parsed out of the
 *     signed JSON. The bytes are authenticated; their interpretation is
 *     asserted by the settler. The verdict body is on 0G Storage under
 *     `storageRoot`, so the pairing is checkable after the fact — by a human,
 *     not by this contract.
 *   - A settler that withholds passes cannot steal them (see below) but can
 *     starve an operator. That is a liveness assumption, not a custody one:
 *     `settle`, `cancel`, `skipHead` and `withdraw` all work without it.
 *   - `pinHash` is PUBLIC here, and so is the operator address. A short PIN is
 *     brute-forced from this chain in microseconds. The PIN exists so the
 *     person standing at the rig is the person who booked it, and so a hub
 *     redeploy can re-bind a live slot to a browser. It is not a secret and
 *     nothing custodial hangs off it. The hub enforces a minimum length and
 *     generates a high-entropy key by default.
 *
 * NOBODY PROFITS FROM A VOID. A slashed stake and the forfeited credits go
 * back into `rewardPool` — never to the treasury and never to the settler,
 * whose choice of which verdicts to submit is the one thing you are asked to
 * trust. Money a liar gives up pays the next honest operator. Draining the
 * pool is a separate, colder key.
 *
 * Credits are forfeited on a void rather than kept, and that is deliberate
 * arithmetic, not moralising: an operator who passes most episodes could
 * otherwise earn more from a slot than the stake is worth and then burn out on
 * three false claims at a profit. Forfeiting closes that. The UI warns at
 * strikes one and two so nobody reaches three by accident, and a discard is
 * always free.
 *
 * There is no rig registry. `rigId` is whatever bytes32 you pass; the hub uses
 * keccak256 of a namespaced rig name. Booking a slot on a rig that does not
 * exist just escrows your stake until you cancel it back.
 *
 * MUST be compiled viaIR: recordEpisode takes 10 arguments and builds a string.
 */
contract SlotMarket is TeeVerifier {
    enum Status {
        None, // 0
        Booked, // 1  staked and queued (may or may not be at the head)
        Running, // 2  unlocked, clock ticking
        Settled, // 3  terminal — stake + accrued rewards paid
        Voided, // 4  terminal — third strike, stake and credits to the pool
        Skipped, // 5  terminal — no-show at the head, stake refunded
        Cancelled // 6  terminal — left the queue voluntarily, stake refunded

    }

    /// uint40 timestamps are good until the year 36812.
    struct Slot {
        bytes32 rigId; // word 0
        address operator; // word 1 (20)
        uint96 stake; //        (12)
        bytes32 pinHash; // word 2
        uint40 bookedAt; // word 3 (5)
        uint40 startedAt; //        (5)  0 until the PIN unlock
        uint40 endAt; //        (5)  0 until the PIN unlock
        uint88 accrued; //        (11) rewards this slot has earned
        uint16 passes; //        (2)
        uint16 episodes; //        (2)
        uint8 strikes; //        (1)
        Status status; //        (1)
    }

    /// Append-only array + a head index that only ever moves forward. A slot
    /// leaves the queue by becoming terminal; nothing is spliced, so there is
    /// no unbounded loop and no linked list to corrupt.
    struct RigQueue {
        uint32 head;
        /// when the CURRENT head reached the front — the no-show clock. It must
        /// not be `bookedAt`, or someone who queued 40 minutes ago would be
        /// skippable the instant they reach the front.
        uint64 headSince;
    }

    uint64 public immutable slotDuration;
    /// A verdict for an episode that closed at 29:58 lands up to ~105s later
    /// (the hub's 15s episode-save wait plus a 90s 0G Compute budget). Refusing
    /// it would make the last minutes of every slot unpayable AND unpunishable.
    uint64 public immutable gradeGrace;
    uint64 public immutable noShowGrace;
    uint96 public immutable minStake;
    uint88 public immutable rewardPerEpisode;

    address public owner; // cold: rotates the settler, drains the pool
    address public settler; // the hub's hot key: relays starts and verdicts
    address public treasury;

    uint256 public nextSlotId = 1;
    mapping(uint256 => Slot) public slots;
    mapping(bytes32 => RigQueue) public rigQueue;
    mapping(bytes32 => uint256[]) private _queue;
    /// One live booking per (rig, operator), or one wallet squats the FIFO.
    mapping(bytes32 => uint256) private _live;
    /// Replay guard: an episode may be graded onto a slot exactly once.
    mapping(bytes32 => bool) public episodeSeen;
    /// Pull-payment fallback; push is attempted first.
    mapping(address => uint256) public owed;

    uint256 public rewardPool;
    uint256 public stakedTotal;
    /// invariant: address(this).balance >= rewardPool + stakedTotal + Σ owed

    uint8 public constant MAX_STRIKES = 3;
    uint256 private constant MAX_PROMOTE = 16;

    uint256 private _lock = 1;

    modifier lock() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "owner only");
        _;
    }

    event SlotBooked(
        uint256 indexed slotId,
        bytes32 indexed rigId,
        address indexed operator,
        uint256 stake,
        uint256 position,
        bytes32 pinHash
    );
    event SlotStarted(uint256 indexed slotId, bytes32 indexed rigId, uint64 endAt);
    event SlotEndedEarly(uint256 indexed slotId, uint64 endAt);
    event EpisodeRecorded(
        uint256 indexed slotId,
        bytes32 indexed episodeId,
        uint16 score,
        bool pass,
        bool claimedSuccess,
        bool attested,
        bytes32 storageRoot,
        uint256 reward
    );
    event Strike(uint256 indexed slotId, address indexed operator, uint8 strikes);
    event SlotVoided(uint256 indexed slotId, address indexed operator, uint256 slashed, uint256 forfeited);
    event SlotSettled(
        uint256 indexed slotId, address indexed operator, uint256 stakeBack, uint256 reward, uint16 passes, uint8 strikes
    );
    event SlotSkipped(uint256 indexed slotId, address indexed operator, uint256 refund);
    event SlotCancelled(uint256 indexed slotId, address indexed operator, uint256 refund);
    /// One event the UI can watch to answer "is the rig mine yet?".
    event HeadChanged(bytes32 indexed rigId, uint256 slotId);
    event RewardsFunded(address indexed from, uint256 amount, uint256 pool);
    event RewardPoolDry(uint256 indexed slotId, uint256 wanted);
    event Paid(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SettlerChanged(address settler);

    constructor(
        address _zgSigner,
        string memory _type,
        string memory _identity,
        address _settler,
        address _treasury,
        uint64 _slotDuration,
        uint64 _gradeGrace,
        uint64 _noShowGrace,
        uint96 _minStake,
        uint88 _rewardPerEpisode
    ) payable TeeVerifier(_zgSigner, _type, _identity) {
        require(_settler != address(0), "settler required");
        require(_treasury != address(0), "treasury required");
        require(_slotDuration > 0, "slot duration required");
        owner = msg.sender;
        settler = _settler;
        treasury = _treasury;
        slotDuration = _slotDuration;
        gradeGrace = _gradeGrace;
        noShowGrace = _noShowGrace;
        minStake = _minStake;
        rewardPerEpisode = _rewardPerEpisode;
        if (msg.value > 0) {
            rewardPool = msg.value;
            emit RewardsFunded(msg.sender, msg.value, msg.value);
        }
    }

    // --- booking ------------------------------------------------------------

    /**
     * Walk up and take the rig, or get in line behind whoever has it. The PIN
     * is committed as keccak256(abi.encodePacked(msg.sender, pin)) and never
     * revealed here — the hub reads this hash with eth_call and checks the
     * typed PIN off-chain.
     *
     * This is the ONLY transaction an operator is ever required to sign.
     */
    function bookSlot(bytes32 rigId, bytes32 pinHash) external payable lock returns (uint256 slotId) {
        require(msg.value >= minStake, "stake below minimum");
        require(msg.value <= type(uint96).max, "stake too large");
        require(pinHash != bytes32(0), "pin hash required");
        bytes32 liveKey = keccak256(abi.encodePacked(rigId, msg.sender));
        uint256 live = _live[liveKey];
        require(live == 0 || _terminal(slots[live].status), "you already hold a slot on this rig");

        // a finished head must not make the queue look longer than it is
        _sweep(rigId);

        slotId = nextSlotId++;
        Slot storage s = slots[slotId];
        s.rigId = rigId;
        s.operator = msg.sender;
        s.stake = uint96(msg.value);
        s.pinHash = pinHash;
        s.bookedAt = uint40(block.timestamp);
        s.status = Status.Booked;

        _live[liveKey] = slotId;
        stakedTotal += msg.value;

        uint256[] storage q = _queue[rigId];
        q.push(slotId);
        RigQueue storage rq = rigQueue[rigId];
        uint256 position = q.length - 1 - rq.head;
        if (position == 0) {
            // the rig was free: it is yours from this instant, and the no-show
            // clock starts now rather than at some past booking
            rq.headSince = uint64(block.timestamp);
            emit HeadChanged(rigId, slotId);
        }
        emit SlotBooked(slotId, rigId, msg.sender, msg.value, position, pinHash);
    }

    /**
     * THE CLOCK STARTS HERE, not at booking. Callable by the operator or by the
     * settler, so the hub can relay a successful PIN unlock and the operator
     * never sees a second wallet popup. The settler can start a slot; it can
     * never own one.
     */
    function startSlot(uint256 slotId) external lock {
        Slot storage s = slots[slotId];
        require(s.status == Status.Booked, "slot not bookable");
        require(msg.sender == s.operator || msg.sender == settler, "not yours to start");
        // self-healing: a predecessor that expired and was never settled must
        // not strand a live operator who is standing at the rig
        _sweep(s.rigId);
        require(_head(s.rigId) == slotId, "not at the head of the queue");
        s.startedAt = uint40(block.timestamp);
        s.endAt = uint40(block.timestamp + slotDuration);
        s.status = Status.Running;
        emit SlotStarted(slotId, s.rigId, s.endAt);
    }

    // --- verdicts -----------------------------------------------------------

    /**
     * One graded episode, with 0G's enclave signature. The check is the point:
     * the settler chooses which verdict to bring, and this decides whether it
     * is real. Only a verdict that lands here can cost anyone anything.
     */
    function recordEpisode(
        uint256 slotId,
        bytes32 episodeId,
        uint16 score,
        bool pass,
        bool claimedSuccess,
        bytes32 storageRoot,
        string calldata requestHashHex,
        bytes calldata responseBytes,
        string calldata tlsFingerprintHex,
        bytes calldata teeSignature
    ) external {
        require(msg.sender == settler, "settler only");
        _requireTee(requestHashHex, responseBytes, tlsFingerprintHex, teeSignature);
        _applyEpisode(slotId, episodeId, score, pass, claimedSuccess, storageRoot, true);
    }

    /**
     * The same accounting for a grade with no attestation — 0G Compute was
     * unreachable and the hub fell back to its local heuristics, which it is
     * designed to do rather than break the loop.
     *
     * An unattested FAIL can NEVER create a strike (see _applyEpisode). The
     * asymmetry is deliberate and runs in the safe direction: without the TEE
     * the hub may be lenient, never punitive. It is recorded so the episode is
     * still visible on chain, flagged `attested: false`.
     */
    function recordEpisodeUnattested(
        uint256 slotId,
        bytes32 episodeId,
        uint16 score,
        bool pass,
        bool claimedSuccess,
        bytes32 storageRoot
    ) external {
        require(msg.sender == settler, "settler only");
        _applyEpisode(slotId, episodeId, score, pass, claimedSuccess, storageRoot, false);
    }

    function _applyEpisode(
        uint256 slotId,
        bytes32 episodeId,
        uint16 score,
        bool pass,
        bool claimedSuccess,
        bytes32 storageRoot,
        bool attested
    ) private {
        Slot storage s = slots[slotId];
        require(s.status == Status.Running, "slot not running");
        require(block.timestamp <= uint256(s.endAt) + gradeGrace, "grading window closed");
        require(!episodeSeen[episodeId], "episode already recorded");
        episodeSeen[episodeId] = true;

        s.episodes += 1;
        uint256 reward = 0;
        if (pass) {
            s.passes += 1;
            // Debit the pool NOW, not at settle: the contract must never
            // promise money it does not hold, and a dry pool has to be visible
            // the moment it happens rather than as a surprise at payout.
            if (rewardPool >= rewardPerEpisode) {
                rewardPool -= rewardPerEpisode;
                s.accrued += rewardPerEpisode;
                reward = rewardPerEpisode;
            } else {
                // NEVER revert: recording the verdict is the safety-critical
                // half, paying for it is not. An operator must not be able to
                // lie for free just because the pool ran dry.
                emit RewardPoolDry(slotId, rewardPerEpisode);
            }
        } else if (claimedSuccess && attested) {
            // the lie, not the failure: an honest discard costs nothing
            s.strikes += 1;
            emit Strike(slotId, s.operator, s.strikes);
        }

        emit EpisodeRecorded(slotId, episodeId, score, pass, claimedSuccess, attested, storageRoot, reward);

        if (s.strikes >= MAX_STRIKES) _void(slotId);
    }

    // --- exits --------------------------------------------------------------

    /**
     * Close a finished slot: stake back plus everything it earned.
     *
     * Only the settler may skip the grading grace, and only because it is the
     * one party that knows whether a verdict is still in flight. Everyone else
     * waits it out, so an operator who saw a bad grade coming can never settle
     * themselves out of a strike.
     */
    function settle(uint256 slotId) external lock {
        Slot storage s = slots[slotId];
        require(s.status == Status.Running, "slot not running");
        require(block.timestamp >= s.endAt, "slot still running");
        require(
            msg.sender == settler || block.timestamp > uint256(s.endAt) + gradeGrace, "grading window still open"
        );
        _settle(slotId);
    }

    /**
     * Done before the clock runs out. This only pulls the end forward — the
     * money still settles on the normal path, so leaving early can never
     * outrun a verdict already in flight.
     */
    function endEarly(uint256 slotId) external {
        Slot storage s = slots[slotId];
        require(s.status == Status.Running, "slot not running");
        require(msg.sender == s.operator, "not your slot");
        require(block.timestamp < s.endAt, "already over");
        s.endAt = uint40(block.timestamp);
        emit SlotEndedEarly(slotId, s.endAt);
    }

    /**
     * A head-of-queue slot nobody ever unlocked. Anyone may skip it after the
     * grace; the stake comes back in full, because not showing up is rude,
     * not fraud. The grace is deliberately short — a free refund plus an open
     * queue is otherwise a cheap way to grief a rig.
     */
    function skipHead(bytes32 rigId) external lock {
        uint256 slotId = _head(rigId);
        require(slotId != 0, "queue empty");
        require(slots[slotId].status == Status.Booked, "head already started");
        require(block.timestamp >= uint256(rigQueue[rigId].headSince) + noShowGrace, "still within the no-show grace");
        _skip(slotId);
    }

    /// Leave the queue before you ever unlock. Full refund.
    function cancel(uint256 slotId) external lock {
        Slot storage s = slots[slotId];
        require(s.status == Status.Booked, "slot not cancellable");
        require(msg.sender == s.operator, "not your slot");
        uint256 stake = s.stake;
        s.stake = 0;
        s.status = Status.Cancelled;
        stakedTotal -= stake;
        emit SlotCancelled(slotId, s.operator, stake);
        _advance(s.rigId, slotId);
        _pay(s.operator, stake);
    }

    /// The one call the hub makes on a timer: close whatever the head is
    /// waiting on. A no-op when nothing is due, so it is safe every tick.
    function sweep(bytes32 rigId) external lock {
        _sweep(rigId);
    }

    // --- money in and out ---------------------------------------------------

    function fundRewards() external payable {
        rewardPool += msg.value;
        emit RewardsFunded(msg.sender, msg.value, rewardPool);
    }

    receive() external payable {
        rewardPool += msg.value;
        emit RewardsFunded(msg.sender, msg.value, rewardPool);
    }

    /**
     * Pull payment, callable BY ANYONE for anyone: the hub pushes payouts so
     * the operator gets no wallet popup, and the operator can always take
     * their own money if the hub is gone. Zeroing before the call is the
     * entire reentrancy story.
     */
    function withdraw(address payee) external lock {
        uint256 amount = owed[payee];
        require(amount > 0, "nothing owed");
        owed[payee] = 0;
        (bool ok,) = payee.call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdrawn(payee, amount);
    }

    function drainPool(uint256 amount) external lock onlyOwner {
        require(amount <= rewardPool, "amount exceeds pool");
        rewardPool -= amount;
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function setSettler(address s) external onlyOwner {
        require(s != address(0), "settler required");
        settler = s;
        emit SettlerChanged(s);
    }

    function setOwner(address o) external onlyOwner {
        require(o != address(0), "owner required");
        owner = o;
    }

    function setTreasury(address t) external onlyOwner {
        require(t != address(0), "treasury required");
        treasury = t;
    }

    // --- views --------------------------------------------------------------

    function currentSlot(bytes32 rigId) external view returns (uint256) {
        return _head(rigId);
    }

    function queueLength(bytes32 rigId) external view returns (uint256) {
        return _queue[rigId].length - rigQueue[rigId].head;
    }

    function queueAt(bytes32 rigId, uint256 offset) external view returns (uint256) {
        uint256 i = rigQueue[rigId].head + offset;
        return i < _queue[rigId].length ? _queue[rigId][i] : 0;
    }

    function liveSlotOf(bytes32 rigId, address op) external view returns (uint256) {
        return _live[keccak256(abi.encodePacked(rigId, op))];
    }

    // --- internals ----------------------------------------------------------

    function _terminal(Status st) private pure returns (bool) {
        return st >= Status.Settled;
    }

    function _head(bytes32 rigId) private view returns (uint256) {
        RigQueue storage rq = rigQueue[rigId];
        uint256[] storage q = _queue[rigId];
        return rq.head < q.length ? q[rq.head] : 0;
    }

    function _advance(bytes32 rigId, uint256 expected) private {
        RigQueue storage rq = rigQueue[rigId];
        uint256[] storage q = _queue[rigId];
        if (rq.head >= q.length || q[rq.head] != expected) return; // wasn't the head
        uint256 moved;
        while (rq.head < q.length && moved < MAX_PROMOTE) {
            if (!_terminal(slots[q[rq.head]].status)) break;
            rq.head += 1;
            ++moved;
        }
        rq.headSince = uint64(block.timestamp);
        emit HeadChanged(rigId, _head(rigId));
    }

    function _sweep(bytes32 rigId) private {
        uint256 slotId = _head(rigId);
        if (slotId == 0) return;
        Slot storage s = slots[slotId];
        if (s.status == Status.Running) {
            if (block.timestamp > uint256(s.endAt) + gradeGrace) _settle(slotId);
        } else if (s.status == Status.Booked) {
            if (block.timestamp >= uint256(rigQueue[rigId].headSince) + noShowGrace) _skip(slotId);
        }
    }

    function _settle(uint256 slotId) private {
        Slot storage s = slots[slotId];
        uint256 stake = s.stake;
        uint256 reward = s.accrued;
        s.stake = 0;
        s.accrued = 0;
        s.status = Status.Settled;
        stakedTotal -= stake;
        emit SlotSettled(slotId, s.operator, stake, reward, s.passes, s.strikes);
        _advance(s.rigId, slotId);
        _pay(s.operator, stake + reward);
    }

    function _skip(uint256 slotId) private {
        Slot storage s = slots[slotId];
        uint256 stake = s.stake;
        s.stake = 0;
        s.status = Status.Skipped;
        stakedTotal -= stake;
        emit SlotSkipped(slotId, s.operator, stake);
        _advance(s.rigId, slotId);
        _pay(s.operator, stake);
    }

    function _void(uint256 slotId) private {
        Slot storage s = slots[slotId];
        uint256 stake = s.stake;
        uint256 forfeited = s.accrued;
        s.stake = 0;
        s.accrued = 0;
        s.status = Status.Voided;
        stakedTotal -= stake;
        // Back to the POOL, not the treasury: nobody profits from a void, least
        // of all the settler. See the contract header.
        rewardPool += stake + forfeited;
        emit SlotVoided(slotId, s.operator, stake, forfeited);
        _advance(s.rigId, slotId);
    }

    /**
     * Push, with a pull fallback. The gas cap is deliberate: we are sending
     * money nobody asked us to send right now, and a hostile payee must not be
     * able to burn the settler's gas or jam the queue for everyone behind
     * them. Anything that cannot take a push calls withdraw().
     */
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 30_000}("");
        if (ok) emit Paid(to, amount);
        else owed[to] += amount;
    }
}
