# Vision Pro direct leader for Hands Unchained

**No MacBook gateway is required.** AVP Isaac Leader can register the Vision
Pro itself as a Hands Unchained leader input device over HTTPS and WebSocket.
It does not open a serial port, advertise Bonjour, or depend on a process
running on another computer.

The browser continues to own the rig lease and chooses the target rig. This is
intentional: the headset is an input device, never an independent controller.

## Connect

1. Install/run **AVP Isaac Leader** on Vision Pro.
2. In **Hands Unchained hub**, leave the app's leader name for the next step.
3. In the app, open **Hands Unchained hub** (above the optional Mac-gateway
   section), enter:
   - **Hub URL** — normally `https://web-production-b5106.up.railway.app`
   - **Leader name** — a unique, recognisable name, e.g. `alice-vision-pro`
   - **Hub token** only when the hub requires one
4. Tap **Connect directly to hub**. The hub lobby now lists that leader.
5. In the browser, take control of a rig and select **Drive with
   alice-vision-pro's leader**.
6. The headset shows the selected rig and its measured pose. Tap **Arm**, then
   **Open Virtual Leader** and grab a control.

Use **Stop** in the headset or browser to disarm immediately and clear the
leader binding. **E-STOP** remains a safety action available from the app while
bound. Neither action releases the browser's lease.

## Safety and transport

The direct client ports the Mac gateway's motion safety behavior into the
headset:

- Browser-selected binding and browser-owned lease are checked every 500 ms.
  A takeover, web stop, expired lease, or hub error disarms AVP output.
- The virtual leader uses relative clutching against the last commanded target,
  not delayed telemetry. Binding changes, arm/disarm, and stale input clear all
  clutches.
- A virtual control frame older than 120 ms may only hold position; one older
  than 500 ms disarms. Active targets are never replayed after UI input stalls.
- Arm joints are smoothed (120 ms), slew limited (8°/s), edge-continued at the
  virtual model envelope, bounded to generic limits, and anti-windup limited
  against reported rig telemetry. Gripper targets are independently clutched
  and slew limited (12%/s).
- Input uses the hub WebSocket fast path at 30 Hz. If it is unavailable, the
  client falls back to HTTPS mailbox input. HTTP remains load-bearing.

The selected rig still validates every target against its own hardware
calibration and applies its own deadman. Start with a simulation; no remote
input client can make a physical arm safe without its local rig safety layer.

## Network requirement

Use HTTPS for any non-loopback hub. The current deployed hub already serves
HTTPS. The app uses a bearer `Authorization` header for both HTTP and the
WebSocket upgrade; it does not put the token into the WebSocket URL.

For a locally hosted development hub, use an HTTPS reverse proxy reachable by
the headset. This avoids relaxing App Transport Security for arbitrary cleartext
LAN traffic.

## Build

```sh
xcodebuild -project AVPIsaacLeader.xcodeproj -scheme AVPIsaacLeader \
  -sdk xrsimulator CODE_SIGNING_ALLOWED=NO build
```
