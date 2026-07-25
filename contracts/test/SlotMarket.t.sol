// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SlotMarket} from "../src/SlotMarket.sol";

/**
 * The state machine and the money, exercised without a chain.
 *
 * The headline is `test_RecordEpisode_RevertsOnTamperedResponse`: today the
 * only proof that a forged verdict is rejected is
 * `apps/web/scripts/smoke-tee-bridge.ts`, which spends real gas on a live
 * testnet to find out. Here it is `vm.sign` against a signer we control, and
 * it runs in milliseconds.
 *
 * `_hexOf` / `_decOf` below are deliberately a SECOND implementation of the
 * digest formatting the contract does — if either drifts, the signature stops
 * recovering and these tests fail. That cross-check is the point.
 */
contract SlotMarketTest is Test {
    SlotMarket internal market;

    uint256 internal constant TEE_PK = 0xA11CE;
    address internal teeSigner;

    address internal owner = address(0xB0B);
    address internal settler = address(0x5E77);
    address internal treasury = address(0x7EA5);
    address internal alice = address(0xA11CE0);
    address internal bob = address(0xB0B0B0);

    bytes32 internal constant RIG = keccak256("proof-of-hands|kris-sim");

    uint64 internal constant SLOT_DURATION = 30 minutes;
    uint64 internal constant GRADE_GRACE = 150;
    uint64 internal constant NO_SHOW_GRACE = 90;
    uint96 internal constant MIN_STAKE = 0.05 ether;
    uint88 internal constant REWARD = 0.002 ether;

    string internal constant P_TYPE = "centralized";
    string internal constant P_IDENT = "aliyun";

    function setUp() public {
        teeSigner = vm.addr(TEE_PK);
        vm.deal(owner, 2 ether); // the constructor seeds the reward pool
        vm.prank(owner);
        market = new SlotMarket{
            value: 1 ether
        }(
            teeSigner,
            P_TYPE,
            P_IDENT,
            settler,
            treasury,
            SLOT_DURATION,
            GRADE_GRACE,
            NO_SHOW_GRACE,
            MIN_STAKE,
            REWARD
        );
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        // block.timestamp starts at 1 in Foundry; the no-show arithmetic
        // subtracts nothing but a realistic clock keeps the traces readable
        vm.warp(1_800_000_000);
    }

    // --- helpers ------------------------------------------------------------

    function _pinHash(address op, string memory pin) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(op, pin));
    }

    function _book(address who, string memory pin) internal returns (uint256 id) {
        vm.prank(who);
        id = market.bookSlot{value: MIN_STAKE}(RIG, _pinHash(who, pin));
    }

    function _start(uint256 id) internal {
        vm.prank(settler);
        market.startSlot(id);
    }

    function _bookAndStart(address who) internal returns (uint256 id) {
        id = _book(who, "correct-horse");
        _start(id);
    }

    function _hexOf(bytes32 value) internal pure returns (string memory) {
        bytes memory symbols = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            out[i * 2] = symbols[uint8(value[i]) >> 4];
            out[i * 2 + 1] = symbols[uint8(value[i]) & 0x0f];
        }
        return string(out);
    }

    /// The exact text the enclave signs, rebuilt independently of the contract.
    function _signedText(string memory reqHash, bytes memory body, string memory tlsFp)
        internal
        pure
        returns (string memory)
    {
        return string(
            abi.encodePacked(
                reqHash, ":", _hexOf(sha256(body)), ":", P_TYPE, ":", P_IDENT, ":", tlsFp
            )
        );
    }

    function _sign(uint256 pk, string memory reqHash, bytes memory body, string memory tlsFp)
        internal
        pure
        returns (bytes memory)
    {
        string memory text = _signedText(reqHash, body, tlsFp);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n", vm.toString(bytes(text).length), text
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    string internal constant REQ =
        "1111111111111111111111111111111111111111111111111111111111111111";
    string internal constant TLS =
        "2222222222222222222222222222222222222222222222222222222222222222";

    /// NOTE: the signature is built BEFORE vm.prank on purpose. `vm.sign` and
    /// `vm.toString` are cheatcode CALLS, so evaluating them in an argument
    /// position would consume the prank and the contract would see this test
    /// contract as msg.sender instead of the settler.
    function _verdict(uint256 slotId, bytes32 epId, uint16 score, bool pass, bool claimed)
        internal
    {
        // a real grader response carries this episode's own telemetry and
        // reason text, so bodies differ per episode; mirror that here
        bytes memory body = _bodyFor(epId, score);
        bytes memory sig = _sign(TEE_PK, REQ, body, TLS);
        vm.prank(settler);
        market.recordEpisode(slotId, epId, score, pass, claimed, bytes32(0), REQ, body, TLS, sig);
    }

    function _body(uint16 score) internal pure returns (bytes memory) {
        return abi.encodePacked('{"score":', vm.toString(uint256(score)), "}");
    }

    function _bodyFor(bytes32 epId, uint16 score) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '{"ep":"', vm.toString(epId), '","score":', vm.toString(uint256(score)), "}"
        );
    }

    function _status(uint256 id) internal view returns (SlotMarket.Status st) {
        (,,,,,,,,,, st) = _slot(id);
    }

    function _slot(uint256 id)
        internal
        view
        returns (
            bytes32 rigId,
            address operator,
            uint96 stake,
            bytes32 pinHash,
            uint40 bookedAt,
            uint40 startedAt,
            uint40 endAt,
            uint88 accrued,
            uint16 passes,
            uint16 episodes,
            SlotMarket.Status status
        )
    {
        uint8 strikes;
        (
                rigId,
                operator,
                stake,
                pinHash,
                bookedAt,
                startedAt,
                endAt,
                accrued,
                passes,
                episodes,
                strikes,
                status
            ) = market.slots(id);
        strikes;
    }

    function _strikes(uint256 id) internal view returns (uint8 s) {
        (,,,,,,,,,, s,) = market.slots(id);
    }

    function _accrued(uint256 id) internal view returns (uint88 a) {
        (,,,,,,, a,,,,) = market.slots(id);
    }

    function _endAt(uint256 id) internal view returns (uint40 e) {
        (,,,,,, e,,,,,) = market.slots(id);
    }

    // --- the PIN commitment -------------------------------------------------

    /// The hub computes this hash in TypeScript and compares it to what the
    /// chain stored. A string-vs-bytes32 mismatch in the encoding would look
    /// exactly like "wrong PIN" and nothing else, so pin it here.
    function test_PinCommitment_MatchesPackedEncoding() public {
        uint256 id = _book(alice, "correct-horse");
        (,,, bytes32 pinHash,,,,,,,) = _slot(id);
        assertEq(pinHash, keccak256(abi.encodePacked(alice, "correct-horse")));
        assertTrue(
            pinHash != keccak256(abi.encodePacked(bob, "correct-horse")),
            "pin must bind to the operator"
        );
    }

    // --- booking ------------------------------------------------------------

    function test_BookSlot_FirstBookerIsHeadAndStakeIsEscrowed() public {
        uint256 id = _book(alice, "pin-one");
        assertEq(market.currentSlot(RIG), id);
        assertEq(market.queueLength(RIG), 1);
        assertEq(market.stakedTotal(), MIN_STAKE);
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Booked));
    }

    function test_BookSlot_RevertsBelowMinStake() public {
        vm.prank(alice);
        vm.expectRevert("stake below minimum");
        market.bookSlot{value: MIN_STAKE - 1}(RIG, _pinHash(alice, "p"));
    }

    function test_BookSlot_RevertsOnEmptyPinHash() public {
        vm.prank(alice);
        vm.expectRevert("pin hash required");
        market.bookSlot{value: MIN_STAKE}(RIG, bytes32(0));
    }

    /// One wallet must not be able to squat several places in the FIFO.
    function test_BookSlot_RevertsOnSecondLiveSlotForSameOperator() public {
        _book(alice, "p");
        vm.prank(alice);
        vm.expectRevert("you already hold a slot on this rig");
        market.bookSlot{value: MIN_STAKE}(RIG, _pinHash(alice, "p2"));
    }

    function test_BookSlot_QueuesBehindTheHolder() public {
        uint256 a = _bookAndStart(alice);
        uint256 b = _book(bob, "bobs-key");
        assertEq(market.currentSlot(RIG), a, "alice still holds the head");
        assertEq(market.queueLength(RIG), 2);
        assertEq(market.queueAt(RIG, 1), b);
    }

    // --- starting -----------------------------------------------------------

    function test_StartSlot_ClockStartsAtUnlockNotBooking() public {
        uint256 id = _book(alice, "p");
        // inside the no-show grace on purpose: warp past it and `_sweep` would
        // (correctly) skip her as a no-show before she ever unlocks
        vm.warp(block.timestamp + NO_SHOW_GRACE - 10);
        _start(id);
        assertEq(
            uint256(_endAt(id)), block.timestamp + SLOT_DURATION, "the 30 minutes start at unlock"
        );
    }

    function test_StartSlot_OperatorMayStartThemselves() public {
        uint256 id = _book(alice, "p");
        vm.prank(alice);
        market.startSlot(id);
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Running));
    }

    function test_StartSlot_RevertsForStranger() public {
        uint256 id = _book(alice, "p");
        vm.prank(bob);
        vm.expectRevert("not yours to start");
        market.startSlot(id);
    }

    function test_StartSlot_RevertsWhenNotAtTheHead() public {
        _bookAndStart(alice);
        uint256 b = _book(bob, "p");
        vm.prank(bob);
        vm.expectRevert("not at the head of the queue");
        market.startSlot(b);
    }

    /// The liveness property: an operator standing at the rig with a valid PIN
    /// must never be stuck because nobody settled the previous slot.
    function test_StartSlot_SweepsAnExpiredPredecessor() public {
        uint256 a = _bookAndStart(alice);
        uint256 b = _book(bob, "p");
        vm.warp(block.timestamp + SLOT_DURATION + GRADE_GRACE + 1);
        vm.prank(bob);
        market.startSlot(b);
        assertEq(uint8(_status(a)), uint8(SlotMarket.Status.Settled), "predecessor settled itself");
        assertEq(uint8(_status(b)), uint8(SlotMarket.Status.Running));
        assertEq(alice.balance, 10 ether, "alice got her stake back on the sweep");
    }

    // --- verdicts and the TEE gate -----------------------------------------

    function test_RecordEpisode_PassCreditsFromThePool() public {
        uint256 id = _bookAndStart(alice);
        uint256 poolBefore = market.rewardPool();
        _verdict(id, keccak256("ep1"), 82, true, true);
        assertEq(_accrued(id), REWARD);
        assertEq(market.rewardPool(), poolBefore - REWARD);
        assertEq(_strikes(id), 0);
    }

    /// THE headline test: flip one byte of the response and the signature no
    /// longer recovers to 0G's signer, so the verdict is refused.
    function test_RecordEpisode_RevertsOnTamperedResponse() public {
        uint256 id = _bookAndStart(alice);
        bytes memory body = bytes('{"score":20,"pass":false}');
        bytes memory sig = _sign(TEE_PK, REQ, body, TLS);
        bytes memory tampered = bytes('{"score":99,"pass":true0}');
        assertEq(body.length, tampered.length, "same length, different bytes");

        vm.prank(settler);
        vm.expectRevert("not signed by 0G TEE");
        market.recordEpisode(
            id, keccak256("ep1"), 99, true, true, bytes32(0), REQ, tampered, TLS, sig
        );
    }

    function test_RecordEpisode_RevertsWhenSignedByAnImpostor() public {
        uint256 id = _bookAndStart(alice);
        bytes memory body = bytes('{"score":90}');
        bytes memory sig = _sign(0xBADBEEF, REQ, body, TLS);
        vm.prank(settler);
        vm.expectRevert("not signed by 0G TEE");
        market.recordEpisode(id, keccak256("ep1"), 90, true, true, bytes32(0), REQ, body, TLS, sig);
    }

    function test_RecordEpisode_RevertsForNonSettler() public {
        uint256 id = _bookAndStart(alice);
        bytes memory body = bytes('{"score":90}');
        bytes memory sig = _sign(TEE_PK, REQ, body, TLS);
        vm.prank(alice);
        vm.expectRevert("settler only");
        market.recordEpisode(id, keccak256("ep1"), 90, true, true, bytes32(0), REQ, body, TLS, sig);
    }

    function test_RecordEpisode_RevertsOnReplayedEpisodeId() public {
        uint256 id = _bookAndStart(alice);
        _verdict(id, keccak256("ep1"), 80, true, true);
        // a FRESH attestation (the referee was asked again and answered
        // differently) for an episode that is already on the books — so this
        // hits the episode guard, not the attestation one
        bytes memory body = _bodyFor(keccak256("ep1"), 81);
        bytes memory sig = _sign(TEE_PK, REQ, body, TLS);
        vm.prank(settler);
        vm.expectRevert("episode already recorded");
        market.recordEpisode(id, keccak256("ep1"), 81, true, true, bytes32(0), REQ, body, TLS, sig);
    }

    /// The subtle replay: `episodeSeen` stops the same EPISODE being graded
    /// twice, but nothing in the TEE-signed text names an episode. Without a
    /// second guard the settler could take one genuine `pass` and mint a
    /// reward per replay — forging by repetition rather than by signature.
    function test_RecordEpisode_RevertsOnReplayedAttestation() public {
        uint256 id = _bookAndStart(alice);
        bytes memory body = _body(80);
        bytes memory sig = _sign(TEE_PK, REQ, body, TLS);

        vm.prank(settler);
        market.recordEpisode(id, keccak256("ep1"), 80, true, true, bytes32(0), REQ, body, TLS, sig);

        // same signature, a DIFFERENT episode id — must not pay twice
        vm.prank(settler);
        vm.expectRevert("attestation already used");
        market.recordEpisode(id, keccak256("ep2"), 80, true, true, bytes32(0), REQ, body, TLS, sig);

        assertEq(_accrued(id), REWARD, "exactly one reward for one verdict");
    }

    /// An episode that closed at 29:58 gets its verdict ~100s later. It must
    /// still count — for payment AND for punishment.
    function test_RecordEpisode_AcceptedInsideTheGradingGrace() public {
        uint256 id = _bookAndStart(alice);
        vm.warp(uint256(_endAt(id)) + GRADE_GRACE - 1);
        _verdict(id, keccak256("late"), 75, true, true);
        assertEq(_accrued(id), REWARD);
    }

    function test_RecordEpisode_RevertsAfterTheGradingGrace() public {
        uint256 id = _bookAndStart(alice);
        vm.warp(uint256(_endAt(id)) + GRADE_GRACE + 1);
        bytes memory body = bytes('{"score":75}');
        bytes memory sig = _sign(TEE_PK, REQ, body, TLS);
        vm.prank(settler);
        vm.expectRevert("grading window closed");
        market.recordEpisode(id, keccak256("late"), 75, true, true, bytes32(0), REQ, body, TLS, sig);
    }

    // --- three strikes ------------------------------------------------------

    function test_Strikes_HonestDiscardNeverStrikes() public {
        uint256 id = _bookAndStart(alice);
        for (uint256 i = 0; i < 5; ++i) {
            _verdict(id, keccak256(abi.encodePacked("discard", i)), 0, false, false);
        }
        assertEq(_strikes(id), 0, "a discard is free, however many times");
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Running));
    }

    function test_Strikes_OneAndTwoAreWarningsOnly() public {
        uint256 id = _bookAndStart(alice);
        _verdict(id, keccak256("lie1"), 10, false, true);
        assertEq(_strikes(id), 1);
        _verdict(id, keccak256("lie2"), 10, false, true);
        assertEq(_strikes(id), 2);
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Running), "still driving after two");
    }

    function test_ThreeStrikes_VoidsTheSlotAndForfeitsEverythingToThePool() public {
        uint256 id = _bookAndStart(alice);
        _verdict(id, keccak256("good"), 90, true, true); // earns one reward
        assertEq(_accrued(id), REWARD);
        uint256 poolAfterEarning = market.rewardPool();

        _verdict(id, keccak256("lie1"), 10, false, true);
        _verdict(id, keccak256("lie2"), 10, false, true);
        _verdict(id, keccak256("lie3"), 10, false, true);

        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Voided));
        assertEq(_strikes(id), 3);
        // stake AND the credits it had earned go back to the pool — nobody
        // profits from a void, and burning out cannot be made +EV
        assertEq(market.rewardPool(), poolAfterEarning + MIN_STAKE + REWARD);
        assertEq(market.stakedTotal(), 0);
        assertEq(market.currentSlot(RIG), 0, "the rig is free again immediately");
    }

    function test_ThreeStrikes_TreasuryGetsNothingDirectly() public {
        uint256 id = _bookAndStart(alice);
        _verdict(id, keccak256("l1"), 0, false, true);
        _verdict(id, keccak256("l2"), 0, false, true);
        _verdict(id, keccak256("l3"), 0, false, true);
        assertEq(treasury.balance, 0, "the settler must never profit from voiding anyone");
    }

    // --- the unattested path ------------------------------------------------

    /// 0G Compute was down, the hub fell back to local heuristics. It may
    /// still pay; it may never punish.
    function test_Unattested_FailNeverStrikes() public {
        uint256 id = _bookAndStart(alice);
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(settler);
            market.recordEpisodeUnattested(
                id, keccak256(abi.encodePacked("u", i)), 5, false, true, bytes32(0)
            );
        }
        assertEq(_strikes(id), 0, "no attestation, no teeth");
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Running));
    }

    function test_Unattested_PassStillCredits() public {
        uint256 id = _bookAndStart(alice);
        vm.prank(settler);
        market.recordEpisodeUnattested(id, keccak256("u1"), 80, true, true, bytes32(0));
        assertEq(_accrued(id), REWARD, "the hub may be lenient without the TEE");
    }

    // --- settlement ---------------------------------------------------------

    function test_Settle_PaysStakePlusCredits() public {
        uint256 id = _bookAndStart(alice);
        _verdict(id, keccak256("e1"), 80, true, true);
        _verdict(id, keccak256("e2"), 80, true, true);
        vm.warp(uint256(_endAt(id)) + GRADE_GRACE + 1);

        market.settle(id); // permissionless
        assertEq(alice.balance, 10 ether + 2 * uint256(REWARD));
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Settled));
        assertEq(market.stakedTotal(), 0);
    }

    function test_Settle_RevertsWhileStillRunning() public {
        uint256 id = _bookAndStart(alice);
        vm.expectRevert("slot still running");
        market.settle(id);
    }

    /// An operator who sees a bad grade coming must not be able to settle
    /// their way out of the strike that is still in flight.
    function test_Settle_NonSettlerMustWaitOutTheGradingWindow() public {
        uint256 id = _bookAndStart(alice);
        vm.warp(uint256(_endAt(id)) + 1);
        vm.prank(alice);
        vm.expectRevert("grading window still open");
        market.settle(id);

        // the settler knows its own grading queue is drained, so it may skip
        vm.prank(settler);
        market.settle(id);
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Settled));
    }

    function test_Settle_RevertsTwice() public {
        uint256 id = _bookAndStart(alice);
        vm.warp(uint256(_endAt(id)) + GRADE_GRACE + 1);
        market.settle(id);
        vm.expectRevert("slot not running");
        market.settle(id);
    }

    function test_EndEarly_PullsTheClockForwardButNotThePayout() public {
        uint256 id = _bookAndStart(alice);
        vm.prank(alice);
        market.endEarly(id);
        assertEq(uint256(_endAt(id)), block.timestamp);
        // still cannot outrun a verdict: the grace applies from the new end
        vm.prank(alice);
        vm.expectRevert("grading window still open");
        market.settle(id);
    }

    // --- queue exits --------------------------------------------------------

    function test_SkipHead_RefundsTheNoShowAndPromotesTheNext() public {
        uint256 a = _book(alice, "p");
        uint256 b = _book(bob, "p");
        vm.warp(block.timestamp + NO_SHOW_GRACE + 1);

        market.skipHead(RIG);
        assertEq(uint8(_status(a)), uint8(SlotMarket.Status.Skipped));
        assertEq(alice.balance, 10 ether, "a no-show is rude, not fraud");
        assertEq(market.currentSlot(RIG), b);
    }

    function test_SkipHead_RevertsInsideTheGrace() public {
        _book(alice, "p");
        vm.expectRevert("still within the no-show grace");
        market.skipHead(RIG);
    }

    function test_SkipHead_RevertsOnceStarted() public {
        _bookAndStart(alice);
        vm.warp(block.timestamp + NO_SHOW_GRACE + 1);
        vm.expectRevert("head already started");
        market.skipHead(RIG);
    }

    /// The no-show clock must run from reaching the front, not from booking —
    /// otherwise someone who queued an hour ago is skippable instantly.
    function test_NoShowClock_StartsWhenYouReachTheFront() public {
        uint256 a = _bookAndStart(alice);
        uint256 b = _book(bob, "p");
        vm.warp(block.timestamp + SLOT_DURATION + GRADE_GRACE + 1);
        market.settle(a); // bob is promoted here
        assertEq(market.currentSlot(RIG), b);

        vm.expectRevert("still within the no-show grace");
        market.skipHead(RIG);
    }

    function test_Cancel_RefundsAndLeavesTheQueue() public {
        uint256 a = _bookAndStart(alice);
        uint256 b = _book(bob, "p");
        vm.prank(bob);
        market.cancel(b);
        assertEq(bob.balance, 10 ether);
        assertEq(uint8(_status(b)), uint8(SlotMarket.Status.Cancelled));
        assertEq(market.currentSlot(RIG), a, "cancelling from mid-queue leaves the head alone");
    }

    function test_Cancel_RevertsOnceRunning() public {
        uint256 id = _bookAndStart(alice);
        vm.prank(alice);
        vm.expectRevert("slot not cancellable");
        market.cancel(id);
    }

    // --- pool and payout edges ---------------------------------------------

    function test_RewardPoolDry_RecordsTheVerdictAnyway() public {
        uint256 pool = market.rewardPool();
        vm.prank(owner);
        market.drainPool(pool);
        assertEq(market.rewardPool(), 0);

        uint256 id = _bookAndStart(alice);
        _verdict(id, keccak256("e1"), 90, true, true);
        assertEq(_accrued(id), 0, "nothing to pay from");

        // and crucially, a lie still costs while the pool is empty
        _verdict(id, keccak256("l1"), 0, false, true);
        assertEq(_strikes(id), 1, "an empty pool must not make lying free");
    }

    function test_Payout_FallsBackToOwedForAHostileReceiver() public {
        Rejector r = new Rejector();
        vm.deal(address(r), 1 ether);
        uint256 id = r.book(market, RIG, MIN_STAKE);
        _start(id);
        vm.warp(uint256(_endAt(id)) + GRADE_GRACE + 1);

        market.settle(id); // must not revert, must not jam the queue
        assertEq(uint8(_status(id)), uint8(SlotMarket.Status.Settled));
        assertEq(market.owed(address(r)), MIN_STAKE);
        assertEq(market.currentSlot(RIG), 0, "the queue moved on regardless");
    }

    function test_Withdraw_IsCallableByAnyoneOnBehalfOfThePayee() public {
        Rejector r = new Rejector();
        vm.deal(address(r), 1 ether);
        uint256 id = r.book(market, RIG, MIN_STAKE);
        _start(id);
        vm.warp(uint256(_endAt(id)) + GRADE_GRACE + 1);
        market.settle(id);

        r.allowReceive();
        vm.prank(bob); // the hub pushes it for them — no wallet popup
        market.withdraw(address(r));
        assertEq(market.owed(address(r)), 0);
        assertEq(address(r).balance, 1 ether);
    }

    function test_FundRewards_TopsUpMidSlot() public {
        uint256 before = market.rewardPool();
        vm.prank(bob);
        market.fundRewards{value: 0.5 ether}();
        assertEq(market.rewardPool(), before + 0.5 ether);
    }

    function test_DrainPool_IsOwnerOnly() public {
        vm.prank(settler);
        vm.expectRevert("owner only");
        market.drainPool(1);
    }

    // --- the balance invariant ---------------------------------------------

    /// The contract must always hold at least what it owes everyone.
    function test_Invariant_BalanceCoversPoolStakesAndOwed() public {
        uint256 a = _bookAndStart(alice);
        _verdict(a, keccak256("e1"), 90, true, true);
        _book(bob, "p");
        _assertSolvent();

        vm.warp(uint256(_endAt(a)) + GRADE_GRACE + 1);
        market.settle(a);
        _assertSolvent();

        vm.warp(block.timestamp + NO_SHOW_GRACE + 1);
        market.skipHead(RIG);
        _assertSolvent();
        assertEq(market.stakedTotal(), 0);
    }

    function _assertSolvent() internal view {
        assertGe(
            address(market).balance,
            market.rewardPool() + market.stakedTotal() + market.owed(alice) + market.owed(bob),
            "contract is insolvent"
        );
    }
}

/// Refuses payment until told otherwise — stands in for a smart-contract
/// wallet, or an operator griefing settlement to jam the queue behind them.
contract Rejector {
    bool public accepting;

    function book(SlotMarket market, bytes32 rigId, uint256 stake) external returns (uint256) {
        return
            market.bookSlot{value: stake}(rigId, keccak256(abi.encodePacked(address(this), "pin")));
    }

    function allowReceive() external {
        accepting = true;
    }

    receive() external payable {
        require(accepting, "no");
    }
}
