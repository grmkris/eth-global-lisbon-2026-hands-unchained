# AVP virtual leader through Hands Unchained

> **Prefer the standalone headset client when no Mac is needed:**
> [DIRECT_HUB_LEADER.md](DIRECT_HUB_LEADER.md) registers Vision Pro directly
> with the hub. This document covers the older optional Mac gateway mode.

This gateway mode does not open a local SO-101 serial port. The Vision Pro sends its
virtual joint state to the Mac over the paired Bonjour protocol; the Mac
registers as a Hands Unchained leader input device and follows the rig binding
chosen in the web hub.

The AVP cannot list, claim, take over, release, or switch hub rigs. The browser
owns the rig lease and is the only place where a leader can be assigned.

## Start the Mac gateway

```sh
./tools/hub-virtual-leader.sh
```

Optional configuration:

```sh
HUB_URL=https://web-production-b5106.up.railway.app \
HUB_TOKEN=... \
LEADER_NAME=my-avp \
ELBOW_MOTION_SCALE=1.0 \
./tools/hub-virtual-leader.sh
```

The terminal prints a four-digit AVP pairing code and the leader name advertised
to the web hub. Leave it running.

## Connect and select a rig

1. On Vision Pro, open **AVP Isaac Leader**, press **Search**, and connect to
   **MacBook AVP Hub Gateway**.
2. Enter the terminal's four-digit code and press **Pair**. The app now waits for
   a web-selected binding; it has no rig selector.
3. In the Hands Unchained web interface, open a rig and take control with the
   browser.
4. Click **Drive with _leader-name_'s leader** on that rig page.
5. The gateway detects the web binding automatically. The AVP displays the rig
   name and synchronizes the inactive virtual model to its telemetry without
   commanding motion.
6. On the AVP, press **Arm**, then **Open Virtual Leader**. Grab a control only
   when ready to move.

Use the web interface to select or change rigs. AVP **Stop** is a safety action:
it disarms locally and asks the hub to clear the leader binding, but it does not
steal or release the browser's rig lease. **E-STOP** remains available while a
rig is bound.

The browser renews its own 20-second lease. Every leader input is accepted only
while that same browser still holds the selected rig, and the gateway checks the
hub binding every 0.5 seconds. A web stop, takeover, expired lease, AVP
disconnect, or gateway shutdown revokes output and clears both clutches.

Grabbing a control captures both the virtual pose and the selected rig's
telemetry pose, so a new web binding cannot send an old virtual absolute pose to
a different calibration.

## Current first-pass limitations

- Hub input uses the existing HTTP fallback. It is functional but slower than
  the leader WebSocket; adding the socket fast path is the next latency step.
- The bridge uses conservative generic degree limits because current hub
  telemetry does not advertise each rig's calibrated limits. The receiving rig
  still enforces its own limits.
- Test against a simulation before assigning a physical rig.

## Tests

```sh
python3 -m unittest discover -s tools -p 'test_*.py'
xcodebuild -project AVPIsaacLeader.xcodeproj -scheme AVPIsaacLeader \
  -sdk xrsimulator CODE_SIGNING_ALLOWED=NO build
```
