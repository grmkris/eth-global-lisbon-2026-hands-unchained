# AVP Isaac Leader

Native visionOS client for Hands Unchained. It registers directly with the hub
as a leader input device: the web operator retains the rig lease and selects
this leader from the rig page. The app has no serial-port dependency and does
not require a Mac gateway.

## Requirements

- Vision Pro running visionOS 2 or later
- Xcode with the visionOS SDK
- A reachable Hands Unchained hub (the deployed hub is the app default)

## Run

Open `AVPIsaacLeader.xcodeproj` in Xcode, select a Vision Pro destination, and
run the `AVPIsaacLeader` scheme. In the app, connect to the hub, then select
this leader from a rig page in the web interface.

The leader volume provides direct spatial controls, single-joint precision
mode, shoulder-pan-only **Swivel only** mode, and the first two camera feeds
advertised by the selected rig. Motion remains disarmed until the web hub binds
the leader and the operator explicitly arms it.

## Validation

```sh
cd apps/avp-client
python3 -m unittest discover -s tools -p 'test_*.py'
xcodebuild -project AVPIsaacLeader.xcodeproj -scheme AVPIsaacLeader \
  -sdk xrsimulator CODE_SIGNING_ALLOWED=NO build
```

`DerivedData/`, Xcode user state, and local worktrees are ignored by the
nested `.gitignore`.
