import ARKit
import RealityKit
import SwiftUI
import UIKit

/// An inverse-kinematic virtual leader. It publishes canonical joint state to
/// the app-level Mac connection; only the Mac gateway can access hardware.
struct VirtualLeaderView: View {
    @Environment(HandTracker.self) private var handTracker
    @Environment(RobotConnectionModel.self) private var robotConnection
    @Environment(LeaderWindowState.self) private var leaderWindow
    @Environment(\.openWindow) private var openWindow
    @State private var leader = VirtualLeaderModel()
    /// A leader volume may be opened only after the browser has armed the
    /// binding. It must still render the follower's *current* pose once before
    /// we suppress armed-time telemetry re-syncs during a live gesture.
    @State private var didInitialFollowerSync = false

    var body: some View {
        RealityView { content in
            content.add(leader.root)
        }
        // A spatial gesture reports one persistent event ID per hand. Targeting
        // it to RealityKit also supplies the coordinate conversion needed to
        // keep both events stable while the arm moves beneath either hand.
        .gesture(
            SpatialEventGesture()
                .targetedToAnyEntity()
                .onChanged { leader.handleSpatialEvents($0, handTracker: handTracker) }
                .onEnded { _ in leader.finishSpatialEvents() }
        )
        .onAppear { leaderWindow.didAppear() }
        .onDisappear { leaderWindow.didDisappear() }
        .task {
            // visionOS may restore only the previously open volume. Ensure the
            // connection/control panel is available whenever that happens,
            // without creating a second settings window.
            if leaderWindow.beginControlOpening() {
                openWindow(id: AppWindow.controlPanel.rawValue, value: AppWindow.controlPanel)
            }
            while !Task.isCancelled {
                // Always make ONE visual-only sync on volume creation. The
                // common flow arms in the control window and opens this volume
                // afterwards; without this exception a collapsed physical arm
                // was drawn at the default unfolded pose. Subsequent syncs stay
                // disarmed-only so a gesture can never be snapped mid-clutch.
                if !didInitialFollowerSync, !robotConnection.actualJoints.isEmpty {
                    leader.synchronizeFollowerPose(
                        robotConnection.actualJoints,
                        revision: robotConnection.followerPoseRevision,
                        force: true
                    )
                    didInitialFollowerSync = true
                } else if !robotConnection.robotArmed {
                    leader.synchronizeFollowerPose(
                        robotConnection.actualJoints,
                        revision: robotConnection.followerPoseRevision
                    )
                }
                leader.updateWristTracking(handTracker)
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
        .task {
            while !Task.isCancelled {
                robotConnection.sendControl(leader.command)
                try? await Task.sleep(for: .milliseconds(33))
            }
        }
        // Keep the SwiftUI controls visible at the base of this volumetric
        // window—the user-facing edge—rather than relying on an attachment
        // plane whose facing can be hidden by platform rotation.
        .overlay(alignment: .bottom) {
            leaderControls
                .padding(.bottom, 12)
        }
    }

    private var leaderControls: some View {
        VStack(spacing: 4) {
                Text("Virtual Isaac Leader")
                    .font(.headline)
                Text(leader.status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Active joint: \(leader.activeJointLabel)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.cyan)
                Toggle("Single joint", isOn: Binding(
                    get: { leader.singleJointMode },
                    set: { leader.setSingleJointMode($0) }
                ))
                .font(.caption)
                Toggle("Swivel only", isOn: Binding(
                    get: { leader.swivelOnlyMode },
                    set: { leader.setSwivelOnlyMode($0) }
                ))
                .font(.caption)
                .disabled(!leader.singleJointMode)
                if leader.singleJointMode {
                    Text(leader.swivelOnlyMode
                         ? "Grab the violet head and drag sideways to swivel"
                         : "Grab a control; its joint alone will move")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(leader.wristDebug)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.yellow)
                Text("Tracker: \(handTracker.statusMessage)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if !robotConnection.hubCameraNames.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(robotConnection.hubCameraNames.prefix(2), id: \.self) { camera in
                            HubCameraPreview(
                                name: camera,
                                jpeg: robotConnection.hubCameraFrames[camera]
                            )
                        }
                    }
                }
                if robotConnection.connectedGatewayID != nil {
                    Text("Robot: \(robotConnection.gatewayMode)")
                        .font(.caption2.monospaced())
                }
                Button {
                    leader.resetToNeutralPose(preservingGripper: true)
                    robotConnection.moveBothToNeutral()
                } label: {
                    Label("Move both to neutral", systemImage: "arrow.uturn.backward")
                }
                .font(.caption2)
                .buttonStyle(.bordered)
                .disabled(!leader.canRecenter || !robotConnection.canMoveBothToNeutral)

                HStack(spacing: 4) {
                    Button {
                        leader.rotatePlatform(byDegrees: -45)
                    } label: {
                        Label("Rotate left", systemImage: "rotate.left")
                    }

                    Button {
                        leader.rotatePlatform(byDegrees: 45)
                    } label: {
                        Label("Rotate right", systemImage: "rotate.right")
                    }

                    Button {
                        if leaderWindow.beginControlOpening() {
                            openWindow(id: AppWindow.controlPanel.rawValue, value: AppWindow.controlPanel)
                        }
                    } label: {
                        Label("Open Controls", systemImage: "network")
                    }
                }
                .font(.caption)
                .buttonStyle(.bordered)
        }
        .padding(8)
        // The panel stays compact beside the leader, but is wide enough for
        // comfortably sized labels, toggles, and two useful camera previews.
        .frame(width: 340)
        .glassBackgroundEffect()
    }
}

/// Compact JPEG tile for the first two camera streams advertised by a bound
/// direct-hub rig. Snapshot polling happens in DirectHubLeaderClient so the
/// view never receives hub credentials or opens its own transport.
private struct HubCameraPreview: View {
    let name: String
    let jpeg: Data?

    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                Color.black
                if let jpeg, let image = UIImage(data: jpeg) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .frame(width: 144, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            Text(name)
                .font(.caption2.monospaced())
                .lineLimit(1)
        }
    }
}

@MainActor
@Observable
final class VirtualLeaderModel {
    private enum WristInputSource {
        case spatialEvent
        case arkit
    }

    /// The selected degree of freedom in precision isolation mode. All other
    /// virtual targets remain unchanged, so the direct-hub clutch holds them.
    enum IsolatedJoint: String, CaseIterable, Identifiable {
        case shoulderPan = "shoulder_pan"
        case shoulderLift = "shoulder_lift"
        case elbowFlex = "elbow_flex"
        case wristFlex = "wrist_flex"
        case wristRoll = "wrist_roll"
        case gripper

        var id: String { rawValue }
        var label: String {
            switch self {
            case .shoulderPan: "Shoulder pan"
            case .shoulderLift: "Shoulder lift"
            case .elbowFlex: "Elbow flex"
            case .wristFlex: "Wrist flex"
            case .wristRoll: "Wrist roll"
            case .gripper: "Gripper"
            }
        }
    }

    let root = Entity()
    private let leaderBody = Entity()
    private let armAssembly = Entity()
    private let endEffector = Entity()
    private let upperLink = ModelEntity()
    private let forearmLink = ModelEntity()
    private let elbowJoint = ModelEntity()
    private let elbowServo = ModelEntity()
    /// Enlarged violet target placed at the physical elbow joint.
    private let elbowControl = ModelEntity()
    private let wristServo = ModelEntity()
    private let wristJoint = ModelEntity()
    private let wristFlexPivot = Entity()
    private let wristRollPivot = Entity()
    private let wristNeck = ModelEntity()
    private let wristRollJoint = ModelEntity()
    // Explicit, enlarged wrist controls remain targetable even when the real
    // compact wrist assembly is hidden behind a folded forearm.
    private let wristFlexControl = ModelEntity()
    private let wristFlexAxisGuide = ModelEntity()
    private let wristRollControl = ModelEntity()
    private let wristRollAxisGuide = ModelEntity()
    private let gripperStem = ModelEntity()
    private let headBulb = ModelEntity()
    private let actuator = ModelEntity()
    private let upperClawPivot = Entity()
    private let lowerClawPivot = Entity()

    private var isHeadGrabbed = false
    private var isActuatorGrabbed = false
    private var headEventID: SpatialEventCollection.Event.ID?
    private var actuatorEventID: SpatialEventCollection.Event.ID?
    private var elbowEventID: SpatialEventCollection.Event.ID?
    private var wristFlexEventID: SpatialEventCollection.Event.ID?
    private var wristRollEventID: SpatialEventCollection.Event.ID?
    private var initialActuatorX: Float = 0
    private var headIsolationOrigin = SIMD3<Float>(repeating: 0)
    private var headIsolationJoint: IsolatedJoint?
    private var initialElbowControlX: Float = 0
    private var initialWristFlexControlY: Float = 0
    private var initialWristRollControlX: Float = 0
    private var actuatorGrabX: Float = 0
    private var grabOffset = SIMD3<Float>(repeating: 0)
    private var wristHand: HandAnchor.Chirality?
    private var wristInputSource: WristInputSource?
    private var latestSpatialWristOrientation: simd_quatf?
    private var initialHandOrientation: simd_quatf?
    private var virtualShoulderPan: Float = 0
    private var virtualShoulderLift: Float = 0
    private var virtualElbowFlex: Float = 0
    private var initialVirtualShoulderLift: Float = 0
    private var virtualForearmAngle: Float = 0
    private var virtualWristFlex: Float = 0
    private var virtualWristRoll: Float = 0
    private var initialVirtualWristFlex: Float = 0
    private var initialVirtualWristRoll: Float = 0
    private var gripperOpening: Float = 0.5
    private var synchronizedFollowerRevision = 0
    private var lastHeadTargetUpdate: TimeInterval?
    private var lastArmJointUpdate: TimeInterval?
    private var lastWristJointUpdate: TimeInterval?
    private var lastGripperUpdate: TimeInterval?
    /// The platform starts turned toward the physical follower. Operators may
    /// adjust this in safe 45° increments without changing any joint command.
    private var platformYaw: Float = .pi

    // SO-101 follower geometry, measured from the RobotStudio CAD-generated
    // `so101_new_calib.urdf` joint origins (metres): shoulder→elbow 0.116 m,
    // elbow→wrist 0.135 m, wrist-flex→roll 0.062 m. We enlarge the real arm
    // uniformly so it remains comfortable to manipulate in a visionOS volume;
    // the ratio and every joint centre remain the physical follower's.
    private let shoulderPosition = SIMD3<Float>(0, 0.10, 0)
    private let upperArmLength: Float = 0.116 * 1.8
    private let forearmLength: Float = 0.135 * 1.8
    private let wristNeckLength: Float = 0.0611 * 1.8
    private let endEffectorOffset: Float = 0.0981 * 1.8
    // In the new mid-range calibration, q=0 is not a horizontal two-link
    // drawing: the CAD joint frames put the upper beam at 104.0° and the lower
    // beam at 177.8° in our mirrored local arm plane. These offsets are the
    // missing conversion that previously made visual pose ≠ follower pose.
    private let shoulderLiftZero: Float = .pi - 1.327
    private let elbowWorldZero: Float = .pi - 0.0385
    private let maxShoulderPan: Float = 110 * .pi / 180
    private let maxShoulderLift: Float = 100 * .pi / 180
    private let maxElbowFlex: Float = 96.8 * .pi / 180
    private let maxWristFlex: Float = 95 * .pi / 180
    private let maxWristRoll: Float = 160 * .pi / 180
    /// Per-joint edge-continuation flags (-1/0/+1). The virtual arm's IK
    /// envelope is smaller than the follower's physical range; while the
    /// operator holds a control PAST a virtual limit the gateway keeps
    /// driving that follower joint in the flagged direction, so the whole
    /// physical envelope stays addressable.
    private var reachSaturation = 0
    private var liftSaturation = 0
    private var wristFlexSaturation = 0
    private var wristRollSaturation = 0
    // Every commandable degree of freedom is rate-limited in the visual input
    // model as well as in the hub client. These are time-based (not frame-based)
    // so event coalescing or a low frame rate can never produce a joint jump.
    private let maximumArmJointSpeedRadiansPerSecond: Float = 0.70
    private let maximumWristJointSpeedRadiansPerSecond: Float = 0.85
    private let maximumGripperSpeedPerSecond: Float = 0.85
    /// Limits the virtual wrist target itself, before IK. The hub-side slew
    /// limiter remains the hardware safety boundary; this one makes a fast
    /// spatial drag legible instead of letting an event coalesce into a jump.
    private let maximumHeadSpeedMetresPerSecond: Float = 0.32
    private let leaderMaterial = SimpleMaterial(color: .systemOrange, roughness: 0.35, isMetallic: true)
    private let jointMaterial = SimpleMaterial(color: .darkGray, roughness: 0.5, isMetallic: true)
    private let actuatorMaterial = SimpleMaterial(color: UIColor.systemTeal.withAlphaComponent(0.45), roughness: 0.25, isMetallic: true)
    private let wristFlexControlMaterial = SimpleMaterial(color: UIColor.systemYellow.withAlphaComponent(0.45), roughness: 0.2, isMetallic: true)
    private let wristRollControlMaterial = SimpleMaterial(color: UIColor.systemMint.withAlphaComponent(0.45), roughness: 0.2, isMetallic: true)
    private let headMaterial = SimpleMaterial(color: UIColor.systemPurple.withAlphaComponent(0.45), roughness: 0.2, isMetallic: true)

    private(set) var status = "Grab the violet bulb to pose the leader. Slide the teal ball with your other hand."
    private(set) var wristDebug = "Wrist debug: waiting for violet-head grab"
    private(set) var singleJointMode = false
    /// Available only with single-joint precision enabled. It locks the violet
    /// head handle to shoulder pan, avoiding direction-based joint selection.
    private(set) var swivelOnlyMode = false

    var canRecenter: Bool {
        !isHeadGrabbed && !isActuatorGrabbed && elbowEventID == nil
            && wristFlexEventID == nil && wristRollEventID == nil
    }

    func setSingleJointMode(_ enabled: Bool) {
        singleJointMode = enabled
        if !enabled { swivelOnlyMode = false }
        headIsolationJoint = nil
        status = enabled
            ? "Single-joint mode — grab a control to select its joint"
            : "Multi-joint mode — controls use their normal behavior"
    }

    func setSwivelOnlyMode(_ enabled: Bool) {
        guard singleJointMode else { return }
        swivelOnlyMode = enabled
        headIsolationJoint = nil
        status = enabled
            ? "Swivel only — grab the violet head and drag sideways"
            : "Single-joint mode — grab a control to select its joint"
    }

    private var activeIsolationJoint: IsolatedJoint? {
        if headEventID != nil { return swivelOnlyMode ? .shoulderPan : headIsolationJoint }
        if elbowEventID != nil { return .shoulderLift }
        if wristFlexEventID != nil { return .wristFlex }
        if wristRollEventID != nil { return .wristRoll }
        if actuatorEventID != nil { return .gripper }
        return nil
    }

    private func allows(_ joint: IsolatedJoint) -> Bool {
        if !singleJointMode { return true }
        if swivelOnlyMode { return headEventID != nil && joint == .shoulderPan }
        return activeIsolationJoint == joint
    }

    private var armControlActive: Bool {
        isHeadGrabbed || elbowEventID != nil || wristFlexEventID != nil || wristRollEventID != nil
    }

    var command: VirtualLeaderCommand {
        VirtualLeaderCommand(
            shoulderPan: virtualShoulderPan,
            shoulderLift: virtualShoulderLift,
            elbowFlex: virtualElbowFlex,
            wristFlex: virtualWristFlex,
            wristRoll: virtualWristRoll,
            gripper: gripperOpening,
            armActive: armControlActive,
            gripperActive: isActuatorGrabbed,
            saturation: [
                "elbow_flex": reachSaturation,
                "shoulder_lift": liftSaturation,
                "wrist_flex": wristFlexSaturation,
                "wrist_roll": wristRollSaturation,
                // Slider held against an end of its rail: keep opening (+1)
                // or closing (-1) the follower until its full range is used.
                "gripper": isActuatorGrabbed
                    ? (gripperOpening >= 0.99 ? 1 : (gripperOpening <= 0.01 ? -1 : 0))
                    : 0,
            ]
        )
    }

    init() {
        buildLeader()
        resetToNeutralPose()
        setClaw(opening: 0.5)
    }

    /// Calibrated joint zero is the SO-101 neutral pose. It is deliberately
    /// not an elbow-straight drawing: applying the actual motor zero values
    /// keeps the visual leader and the follower's neutral command identical.
    func resetToNeutralPose(preservingGripper: Bool = false) {
        guard canRecenter else { return }
        applyFollowerPose(
            shoulderPan: 0,
            shoulderLift: 0,
            elbowFlex: 0,
            wristFlex: 0,
            wristRoll: 0,
            snap: true
        )
        if !preservingGripper {
            setClaw(opening: 0.5, snap: true)
        }
        lastHeadTargetUpdate = nil
        status = preservingGripper
            ? "SO-101 neutral ready — keeping the current gripper hold"
            : "SO-101 calibrated neutral ready — arm to move both arms here"
        wristDebug = "Wrist debug: calibrated neutral"
    }

    func synchronizeFollowerPose(
        _ joints: [String: Double],
        revision: Int,
        force: Bool = false
    ) {
        guard (force || revision > synchronizedFollowerRevision), canRecenter else { return }
        guard let shoulderPan = joints["shoulder_pan"],
              let shoulderLift = joints["shoulder_lift"],
              let elbowFlex = joints["elbow_flex"] else { return }

        // Use the calibrated follower motor angles directly. This is forward
        // kinematics from the upstream SO-101 URDF, not a foldedness heuristic:
        // telemetry and the visible arm now have the same joint pose.
        applyFollowerPose(
            // The visual platform faces the operator in a mirrored frame, so
            // follower shoulder-pan telemetry has the inverse display sign.
            shoulderPan: -Float(shoulderPan * .pi / 180),
            shoulderLift: Float(shoulderLift * .pi / 180),
            elbowFlex: Float(elbowFlex * .pi / 180),
            wristFlex: Float((joints["wrist_flex"] ?? 0) * .pi / 180),
            wristRoll: Float((joints["wrist_roll"] ?? 0) * .pi / 180),
            snap: true
        )
        if let gripper = joints["gripper"] {
            setClaw(opening: Float(gripper / 100), snap: true)
        }

        synchronizedFollowerRevision = revision
        status = "Synchronized to SO-101 follower pose — grab a control when ready"
        wristDebug = "Wrist debug: CAD joint geometry + follower telemetry"
    }

    private func buildLeader() {
        root.name = "leader-platform"
        // Sit the compact platform close to the lower edge of the enlarged
        // volume rather than floating in its vertical middle.
        root.position = [0, -0.38, 0]
        // The complete model—including every collision target—is half scale.
        // Keep it centered in the deliberately larger volumetric window.
        root.scale = SIMD3<Float>(repeating: 0.5)
        // Face the operator from the same side as the physical follower.
        root.orientation = simd_quatf(angle: platformYaw, axis: [0, 1, 0])

        let platform = part(name: "leader-base-surface", mesh: .generateBox(size: [0.56, 0.025, 0.38]), material: jointMaterial)
        platform.position = [-0.03, -0.05, 0]
        root.addChild(platform)

        // SO-101's printed base is wide and low (about 111 × 72 × 87 mm),
        // followed by stacked STS3215 motor housings. Keep the visual model at
        // one scale; unlike the old 0.72 body scale, beams and motors share
        // the same CAD-derived proportions.
        root.addChild(leaderBody)
        let base = part(name: "so101-base", mesh: .generateBox(size: [0.20, 0.11, 0.15]), material: leaderMaterial)
        leaderBody.addChild(base)
        let baseServo = part(name: "shoulder-pan-servo", mesh: .generateBox(size: [0.065, 0.052, 0.050]), material: jointMaterial)
        baseServo.position = [0, 0.075, 0]
        leaderBody.addChild(baseServo)
        leaderBody.addChild(armAssembly)

        let shoulder = part(name: "shoulder", mesh: .generateSphere(radius: 0.052), material: jointMaterial)
        shoulder.position = shoulderPosition
        armAssembly.addChild(shoulder)

        // The follower's printed upper/under arms are rectangular beams, not
        // generic cylinders. Their 116:135 joint-centre ratio comes from the
        // RobotStudio SO-101 follower URDF.
        upperLink.name = "so101-upper-arm"
        upperLink.model = ModelComponent(mesh: .generateBox(size: [upperArmLength, 0.050, 0.044]), materials: [leaderMaterial])
        armAssembly.addChild(upperLink)

        elbowJoint.name = "so101-elbow-axis"
        elbowJoint.model = ModelComponent(mesh: .generateCylinder(height: 0.060, radius: 0.027), materials: [jointMaterial])
        elbowJoint.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        armAssembly.addChild(elbowJoint)
        elbowServo.name = "elbow-servo"
        elbowServo.model = ModelComponent(mesh: .generateBox(size: [0.065, 0.052, 0.050]), materials: [jointMaterial])
        armAssembly.addChild(elbowServo)

        // The elbow's compact physical servo can disappear against a folded
        // forearm, so expose its own violet pinch target beside the joint.
        elbowControl.name = "elbow-control"
        elbowControl.model = ModelComponent(
            mesh: .generateSphere(radius: 0.045), materials: [headMaterial]
        )
        configureInteraction(elbowControl, size: [0.14, 0.14, 0.14])
        armAssembly.addChild(elbowControl)

        forearmLink.name = "so101-under-arm"
        forearmLink.model = ModelComponent(mesh: .generateBox(size: [forearmLength, 0.050, 0.044]), materials: [leaderMaterial])
        armAssembly.addChild(forearmLink)

        // Model both physical wrist motors instead of collapsing them into one
        // visual node: flex at the forearm tip, then roll after a short neck.
        wristJoint.name = "wrist-flex-axis"
        wristJoint.model = ModelComponent(mesh: .generateCylinder(height: 0.060, radius: 0.026), materials: [jointMaterial])
        wristJoint.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        armAssembly.addChild(wristJoint)
        wristServo.name = "wrist-flex-servo"
        wristServo.model = ModelComponent(mesh: .generateBox(size: [0.065, 0.052, 0.050]), materials: [jointMaterial])
        armAssembly.addChild(wristServo)

        wristFlexPivot.name = "wrist-flex-pivot"
        armAssembly.addChild(wristFlexPivot)

        wristNeck.name = "wrist-neck"
        wristNeck.model = ModelComponent(
            mesh: .generateBox(size: [wristNeckLength, 0.035, 0.035]),
            materials: [leaderMaterial]
        )
        wristNeck.position = [-wristNeckLength / 2, 0, 0]
        wristFlexPivot.addChild(wristNeck)

        wristRollPivot.name = "wrist-roll-pivot"
        wristRollPivot.position = [-wristNeckLength, 0, 0]
        wristFlexPivot.addChild(wristRollPivot)

        wristRollJoint.name = "wrist-roll-joint"
        wristRollJoint.model = ModelComponent(
            mesh: .generateCylinder(height: 0.060, radius: 0.028),
            materials: [jointMaterial]
        )
        wristRollJoint.orientation = simd_quatf(angle: .pi / 2, axis: [0, 1, 0])
        wristRollPivot.addChild(wristRollJoint)

        // Directional wrist handles replace the ambiguous free 3D spheres.
        // Yellow is a vertical flex handle; mint is a horizontal roll handle.
        // Their rails show the only drag direction each handle accepts.
        wristFlexAxisGuide.name = "wrist-flex-axis-guide"
        wristFlexAxisGuide.model = ModelComponent(
            mesh: .generateBox(size: [0.016, 0.130, 0.016]),
            materials: [wristFlexControlMaterial]
        )
        armAssembly.addChild(wristFlexAxisGuide)
        wristFlexControl.name = "wrist-flex-control"
        wristFlexControl.model = ModelComponent(
            mesh: .generateCylinder(height: 0.014, radius: 0.047),
            materials: [wristFlexControlMaterial]
        )
        configureInteraction(wristFlexControl, size: [0.100, 0.170, 0.070])
        armAssembly.addChild(wristFlexControl)

        wristRollAxisGuide.name = "wrist-roll-axis-guide"
        wristRollAxisGuide.model = ModelComponent(
            mesh: .generateBox(size: [0.130, 0.016, 0.016]),
            materials: [wristRollControlMaterial]
        )
        armAssembly.addChild(wristRollAxisGuide)
        wristRollControl.name = "wrist-roll-control"
        wristRollControl.model = ModelComponent(
            mesh: .generateCylinder(height: 0.014, radius: 0.047),
            materials: [wristRollControlMaterial]
        )
        configureInteraction(wristRollControl, size: [0.170, 0.100, 0.070])
        armAssembly.addChild(wristRollControl)

        // CAD: wrist-flex→roll is 61.1 mm and roll→gripper frame is 98.1 mm.
        // The former is wristNeck; this latter printed wrist-roll follower
        // stem was missing, leaving the gripper visually detached.
        gripperStem.name = "so101-wrist-roll-follower"
        gripperStem.model = ModelComponent(
            mesh: .generateBox(size: [endEffectorOffset, 0.050, 0.050]),
            materials: [leaderMaterial]
        )
        gripperStem.position = [-endEffectorOffset / 2, 0, 0]
        wristRollPivot.addChild(gripperStem)
        endEffector.position = [-endEffectorOffset, 0, 0]
        wristRollPivot.addChild(endEffector)

        let palm = part(name: "claw-palm", mesh: .generateBox(size: [0.10, 0.055, 0.065]), material: leaderMaterial)
        endEffector.addChild(palm)

        // SO-101 follower: Wrist_Roll_Follower is the fixed jaw and
        // Moving_Jaw is the one motor-driven jaw. The old symmetric pincer
        // looked generic and implied a joint the physical follower does not
        // have; keep one fixed finger and rotate only the moving jaw.
        upperClawPivot.name = "so101-moving-jaw"
        upperClawPivot.position = [-0.045, 0.03, 0]
        let upperFinger = part(name: "moving-jaw", mesh: .generateBox(size: [0.11, 0.020, 0.024]), material: jointMaterial)
        upperFinger.position = [-0.055, 0, 0]
        upperClawPivot.addChild(upperFinger)
        endEffector.addChild(upperClawPivot)

        lowerClawPivot.name = "so101-fixed-jaw"
        lowerClawPivot.position = [-0.045, -0.03, 0]
        let lowerFinger = part(name: "fixed-jaw", mesh: .generateBox(size: [0.11, 0.024, 0.030]), material: leaderMaterial)
        lowerFinger.position = [-0.055, 0, 0]
        lowerClawPivot.addChild(lowerFinger)
        endEffector.addChild(lowerClawPivot)

        // Keep the drag handle above the wrist in the arm plane. It does not
        // inherit wrist roll, so it can never orbit underneath the model.
        headBulb.name = "leader-head"
        headBulb.model = ModelComponent(mesh: .generateSphere(radius: 0.065), materials: [headMaterial])
        configureInteraction(headBulb, size: [0.15, 0.15, 0.15])
        armAssembly.addChild(headBulb)

        // Put the claw ball on the platform edge nearest the user.
        actuator.name = "claw-actuator"
        actuator.model = ModelComponent(mesh: .generateSphere(radius: 0.055), materials: [actuatorMaterial])
        actuator.position = [0, 0.02, 0.20]
        configureInteraction(actuator, size: [0.13, 0.13, 0.13])
        root.addChild(actuator)

        let track = part(name: "actuator-track", mesh: .generateBox(size: [0.32, 0.015, 0.02]), material: jointMaterial)
        track.position = [0, 0.02, 0.20]
        root.addChild(track)
    }

    func rotatePlatform(byDegrees degrees: Float) {
        platformYaw = normalizedAngle(platformYaw + (degrees * .pi / 180))
        root.orientation = simd_quatf(angle: platformYaw, axis: [0, 1, 0])
        status = "Leader platform rotated \(Int(degrees > 0 ? degrees : -degrees))° \(degrees > 0 ? "right" : "left")"
    }

    private func part(name: String, mesh: MeshResource, material: SimpleMaterial) -> ModelEntity {
        let entity = ModelEntity(mesh: mesh, materials: [material])
        entity.name = name
        return entity
    }

    private func configureInteraction(_ entity: ModelEntity, size: SIMD3<Float>) {
        entity.components.set(CollisionComponent(shapes: [.generateBox(size: size)]))
        entity.components.set(InputTargetComponent())
    }

    func handleSpatialEvents(
        _ value: EntityTargetValue<SpatialEventGesture.Value>,
        handTracker: HandTracker
    ) {
        for event in value.gestureValue {
            if event.phase == .ended || event.phase == .cancelled {
                finishSpatialEvent(event.id)
                continue
            }

            // Once an event claims a control, retain that assignment even if
            // its ray/contact moves beyond the original collision shape.
            if headEventID == event.id {
                updateSpatialWristOrientation(from: event, value: value)
                let grabPoint = value.convert(event.location3D, from: .local, to: leaderBody)
                updateHeadPosition(grabPoint + grabOffset)
                continue
            }
            if actuatorEventID == event.id {
                let point = value.convert(event.location3D, from: .local, to: root)
                updateActuatorPosition(initialActuatorX + point.x - actuatorGrabX)
                continue
            }
            if elbowEventID == event.id {
                let point = value.convert(event.location3D, from: .local, to: leaderBody)
                updateShoulderFromElbowControl(point.x)
                continue
            }
            if wristFlexEventID == event.id {
                let point = value.convert(event.location3D, from: .local, to: leaderBody)
                updateExplicitWristFlex(point.y)
                continue
            }
            if wristRollEventID == event.id {
                let point = value.convert(event.location3D, from: .local, to: leaderBody)
                updateExplicitWristRoll(point.x)
                continue
            }

            guard let target = event.targetedEntity else { continue }
            switch target.name {
            case "leader-head" where !armControlActive:
                headEventID = event.id
                isHeadGrabbed = true
                selectControl("leader-head")

                // Use the nonrotating body frame. Converting through the arm
                // assembly would feed its changing base yaw back into the drag.
                let grabPoint = value.convert(event.location3D, from: .local, to: leaderBody)
                grabOffset = wristJoint.position(relativeTo: leaderBody) - grabPoint
                headIsolationOrigin = grabPoint + grabOffset
                headIsolationJoint = nil

                if event.chirality == .left {
                    wristHand = .left
                } else if event.chirality == .right {
                    wristHand = .right
                } else {
                    wristHand = handTracker.preferredPinchingHand()
                }
                updateSpatialWristOrientation(from: event, value: value)
                if let latestSpatialWristOrientation {
                    wristInputSource = .spatialEvent
                    initialHandOrientation = latestSpatialWristOrientation
                } else if let wristHand,
                          let orientation = handTracker.wristOrientation(for: wristHand) {
                    wristInputSource = .arkit
                    initialHandOrientation = orientation
                }
                initialVirtualWristFlex = virtualWristFlex
                initialVirtualWristRoll = virtualWristRoll
                lastHeadTargetUpdate = nil
                if let wristHand, initialHandOrientation != nil {
                    let source = wristInputSource == .spatialEvent ? "spatial" : "ARKit"
                    wristDebug = "Wrist debug: \(source) \(wristHand == .left ? "L" : "R") captured at 0°"
                } else {
                    wristDebug = "Wrist debug: waiting for head-hand orientation"
                }
                updateHeadPosition(grabPoint + grabOffset)

            case "elbow-control" where !armControlActive && !swivelOnlyMode:
                elbowEventID = event.id
                selectControl("elbow-control")
                let point = value.convert(event.location3D, from: .local, to: leaderBody)
                initialElbowControlX = point.x
                initialVirtualShoulderLift = virtualShoulderLift
                lastArmJointUpdate = ProcessInfo.processInfo.systemUptime
                status = "Shoulder fold active — pull violet elbow control backward/forward"

            case "wrist-flex-control" where !armControlActive && !swivelOnlyMode:
                wristFlexEventID = event.id
                selectControl("wrist-flex-control")
                let point = value.convert(event.location3D, from: .local, to: leaderBody)
                initialWristFlexControlY = point.y
                initialVirtualWristFlex = virtualWristFlex
                lastWristJointUpdate = ProcessInfo.processInfo.systemUptime
                status = "Wrist flex active — drag yellow control vertically"

            case "wrist-roll-control" where !armControlActive && !swivelOnlyMode:
                wristRollEventID = event.id
                selectControl("wrist-roll-control")
                let point = value.convert(event.location3D, from: .local, to: leaderBody)
                initialWristRollControlX = point.x
                initialVirtualWristRoll = virtualWristRoll
                lastWristJointUpdate = ProcessInfo.processInfo.systemUptime
                status = "Wrist roll active — drag mint control horizontally"

            case "claw-actuator" where actuatorEventID == nil && !swivelOnlyMode:
                actuatorEventID = event.id
                isActuatorGrabbed = true
                selectControl("claw-actuator")
                let point = value.convert(event.location3D, from: .local, to: root)
                actuatorGrabX = point.x
                initialActuatorX = actuator.position.x
                updateActuatorPosition(initialActuatorX)

            default:
                break
            }
        }

        updateInteractionStatus()
    }

    private func updateSpatialWristOrientation(
        from event: SpatialEventCollection.Event,
        value: EntityTargetValue<SpatialEventGesture.Value>
    ) {
        guard let inputPose = event.inputDevicePose else { return }
        latestSpatialWristOrientation = value.convert(
            inputPose.pose3D.rotation,
            from: .local,
            to: leaderBody
        )
        if wristInputSource == nil {
            wristInputSource = .spatialEvent
        }
    }

    private func updateHeadPosition(_ requested: SIMD3<Float>) {
        selectHeadIsolationJointIfNeeded(requested)
        // The visual leader clamps vertical travel to this box. Preserve which
        // boundary the operator is pressing against so the gateway can
        // continue into the follower's larger physical envelope rather than
        // treating the clamped pose as a stationary command.
        let verticalBoundary = requested.y >= 0.60 ? 1 : (requested.y <= 0.12 ? -1 : 0)
        let bounded = SIMD3<Float>(
            max(-0.34, min(0.20, requested.x)),
            max(0.12, min(0.60, requested.y)),
            max(-0.22, min(0.22, requested.z))
        )

        // SpatialEventGesture may coalesce a large hand movement into one
        // update. Rate-limit the virtual wrist target before solving IK, so
        // the model follows a fast drag smoothly at a capped 0.32 m/s instead
        // of teleporting through its workspace (and resetting clutches).
        let now = ProcessInfo.processInfo.systemUptime
        let current = wristJoint.position(relativeTo: leaderBody)
        let elapsed = lastHeadTargetUpdate.map { min(0.10, max(0.001, now - $0)) }
        lastHeadTargetUpdate = now
        let target: SIMD3<Float>
        if let elapsed {
            let delta = bounded - current
            let distance = simd_length(delta)
            let maximumStep = maximumHeadSpeedMetresPerSecond * Float(elapsed)
            target = distance > maximumStep && distance > 0.0001
                ? current + (delta / distance) * maximumStep
                : bounded
        } else {
            // Engagement captures grabOffset at the current wrist pose, so the
            // first target is normally zero-delta. Still use it directly to
            // avoid a one-frame latency on a newly grabbed control.
            target = bounded
        }
        setEndEffector(position: target, verticalBoundary: verticalBoundary)
    }

    private func selectHeadIsolationJointIfNeeded(_ requested: SIMD3<Float>) {
        guard singleJointMode, headEventID != nil, headIsolationJoint == nil else { return }
        if swivelOnlyMode {
            headIsolationJoint = .shoulderPan
            status = "Swivel only — violet head controls shoulder pan"
            return
        }
        let delta = requested - headIsolationOrigin
        let horizontal = max(abs(delta.x), abs(delta.z))
        guard max(horizontal, abs(delta.y)) >= 0.012 else { return }

        // Use the first deliberate pull direction as the head handle's joint
        // choice. Subsequent motion cannot switch joints mid-clutch.
        if abs(delta.y) > horizontal {
            headIsolationJoint = .shoulderLift
        } else if abs(delta.z) >= abs(delta.x) {
            headIsolationJoint = .shoulderPan
        } else {
            headIsolationJoint = .elbowFlex
        }
        if let headIsolationJoint {
            status = "Single-joint mode — violet head controls \(headIsolationJoint.label)"
        }
    }

    private func updateActuatorPosition(_ requestedX: Float) {
        guard allows(.gripper) else {
            status = "Single-joint mode — gripper is frozen"
            return
        }
        let x = max(-0.15, min(0.15, requestedX))
        setClaw(opening: (x + 0.15) / 0.30)
        // Keep the visible rail control attached to the capped moving jaw;
        // otherwise the handle would teleport while its joint moved slowly.
        actuator.position.x = (gripperOpening * 0.30) - 0.15
    }

    private func updateShoulderFromElbowControl(_ controlX: Float) {
        guard allows(.shoulderLift) else {
            status = "Single-joint mode — shoulder lift is frozen"
            return
        }
        // This is a proximal pull handle, not an elbow-flex motor control.
        // Pulling it back/forward changes shoulder lift while preserving the
        // elbow hinge coordinate, so the arm folds from its base as intended.
        let raw = initialVirtualShoulderLift - (controlX - initialElbowControlX) * 8
        let requested = clamped(raw, minimum: -maxShoulderLift, maximum: maxShoulderLift)
        liftSaturation = raw > maxShoulderLift ? 1 : (raw < -maxShoulderLift ? -1 : 0)
        applyFollowerPose(
            shoulderPan: virtualShoulderPan,
            shoulderLift: requested,
            elbowFlex: virtualElbowFlex,
            wristFlex: virtualWristFlex,
            wristRoll: virtualWristRoll
        )
        wristDebug = "Shoulder debug: violet elbow pull control"
        status = "Shoulder fold active — pull violet elbow control backward/forward"
    }

    private func updateExplicitWristFlex(_ controlY: Float) {
        guard allows(.wristFlex) else {
            status = "Single-joint mode — wrist flex is frozen"
            return
        }
        let raw = initialVirtualWristFlex + (controlY - initialWristFlexControlY) * 8
        wristFlexSaturation = raw > maxWristFlex ? 1 : (raw < -maxWristFlex ? -1 : 0)
        setExplicitWrist(
            flex: clamped(raw, minimum: -maxWristFlex, maximum: maxWristFlex),
            roll: virtualWristRoll
        )
        wristDebug = "Wrist debug: yellow flex control"
    }

    private func updateExplicitWristRoll(_ controlX: Float) {
        guard allows(.wristRoll) else {
            status = "Single-joint mode — wrist roll is frozen"
            return
        }
        let raw = initialVirtualWristRoll + (controlX - initialWristRollControlX) * 8
        wristRollSaturation = raw > maxWristRoll ? 1 : (raw < -maxWristRoll ? -1 : 0)
        setExplicitWrist(
            flex: virtualWristFlex,
            roll: clamped(raw, minimum: -maxWristRoll, maximum: maxWristRoll)
        )
        wristDebug = "Wrist debug: mint roll control"
    }

    private func setExplicitWrist(flex: Float, roll: Float) {
        let now = ProcessInfo.processInfo.systemUptime
        let dt = lastWristJointUpdate.map { cappedElapsed(now - $0) } ?? 0
        let step = maximumWristJointSpeedRadiansPerSecond * Float(dt)
        virtualWristFlex = moved(virtualWristFlex, toward: flex, maximumStep: step)
        virtualWristRoll = moved(virtualWristRoll, toward: roll, maximumStep: step)
        lastWristJointUpdate = now
        updateWristPose()
        status = "Wrist control active — release before moving another control"
    }

    func updateWristTracking(_ handTracker: HandTracker) {
        guard isHeadGrabbed else { return }

        // Prefer the pose carried by the exact spatial event that owns the
        // violet handle. ARKit remains a fallback for input devices that don't
        // include a pose in their event.
        if wristHand == nil {
            wristHand = handTracker.preferredPinchingHand()
        }
        guard let wristHand else {
            wristDebug = "Wrist debug: waiting to identify the head hand"
            return
        }

        let currentHandOrientation: simd_quatf?
        switch wristInputSource {
        case .spatialEvent:
            currentHandOrientation = latestSpatialWristOrientation
        case .arkit:
            currentHandOrientation = handTracker.wristOrientation(for: wristHand)
        case nil:
            if let spatialOrientation = latestSpatialWristOrientation {
                wristInputSource = .spatialEvent
                currentHandOrientation = spatialOrientation
            } else if let arkitOrientation = handTracker.wristOrientation(for: wristHand) {
                wristInputSource = .arkit
                currentHandOrientation = arkitOrientation
            } else {
                currentHandOrientation = nil
            }
        }
        guard let currentHandOrientation else {
            wristDebug = "Wrist debug: waiting for \(wristHand == .left ? "left" : "right") hand orientation"
            return
        }
        if initialHandOrientation == nil {
            initialHandOrientation = currentHandOrientation
            initialVirtualWristFlex = virtualWristFlex
            initialVirtualWristRoll = virtualWristRoll
            let source = wristInputSource == .spatialEvent ? "spatial" : "ARKit"
            wristDebug = "Wrist debug: \(source) \(wristHand == .left ? "L" : "R") captured at 0°"
            return
        }
        guard let initialHandOrientation else { return }

        // This is driven by the tracked wrist orientation, not a separate UI
        // rotation gesture. Twisting the pinched hand like a lightbulb twists
        // the virtual wrist and pincer around its wrist joint.
        let handDelta = currentHandOrientation * initialHandOrientation.inverse

        // The SO-101 has one flex hinge and one roll axis at the wrist. Reduce
        // the full tracked-hand delta to those axes, clamp both well short of a
        // half-turn, and slew the virtual joints to reject tracking jumps.
        let longitudinal = handDelta.act(SIMD3<Float>(1, 0, 0))
        let flexDelta = atan2(longitudinal.y, longitudinal.x)
        let rawFlex = initialVirtualWristFlex + flexDelta
        let rawRoll = initialVirtualWristRoll + twistAngleAroundX(handDelta)
        wristFlexSaturation = allows(.wristFlex)
            ? (rawFlex > maxWristFlex ? 1 : (rawFlex < -maxWristFlex ? -1 : 0))
            : 0
        wristRollSaturation = allows(.wristRoll)
            ? (rawRoll > maxWristRoll ? 1 : (rawRoll < -maxWristRoll ? -1 : 0))
            : 0
        let requestedFlex = allows(.wristFlex)
            ? clamped(rawFlex, minimum: -maxWristFlex, maximum: maxWristFlex)
            : virtualWristFlex
        let requestedRoll = allows(.wristRoll)
            ? clamped(rawRoll, minimum: -maxWristRoll, maximum: maxWristRoll)
            : virtualWristRoll
        let now = ProcessInfo.processInfo.systemUptime
        let dt = lastWristJointUpdate.map { cappedElapsed(now - $0) } ?? 0
        let step = maximumWristJointSpeedRadiansPerSecond * Float(dt)
        virtualWristFlex = moved(
            virtualWristFlex,
            toward: requestedFlex,
            maximumStep: step
        )
        virtualWristRoll = moved(
            virtualWristRoll,
            toward: requestedRoll,
            maximumStep: step
        )
        lastWristJointUpdate = now
        updateWristPose()

        let source = wristInputSource == .spatialEvent ? "spatial" : "ARKit"
        let flexDegrees = Int((virtualWristFlex * 180 / .pi).rounded())
        let rollDegrees = Int((virtualWristRoll * 180 / .pi).rounded())
        wristDebug = "Wrist debug: \(source) \(wristHand == .left ? "L" : "R") flex \(flexDegrees)° roll \(rollDegrees)°"
        status = isActuatorGrabbed
            ? "Both controls active — posing the arm and sliding the claw"
            : "Wrist twist active — pincer follows your hand"
    }

    private func finishSpatialEvent(_ id: SpatialEventCollection.Event.ID) {
        if headEventID == id {
            headEventID = nil
            isHeadGrabbed = false
            wristHand = nil
            wristInputSource = nil
            headIsolationJoint = nil
            lastHeadTargetUpdate = nil
            latestSpatialWristOrientation = nil
            initialHandOrientation = nil
        }
        if actuatorEventID == id {
            actuatorEventID = nil
            isActuatorGrabbed = false
        }
        if elbowEventID == id {
            elbowEventID = nil
            liftSaturation = 0
            lastArmJointUpdate = nil
        }
        if wristFlexEventID == id {
            wristFlexEventID = nil
            wristFlexSaturation = 0
            lastWristJointUpdate = nil
        }
        if wristRollEventID == id {
            wristRollEventID = nil
            wristRollSaturation = 0
            lastWristJointUpdate = nil
        }
        selectControl(activeControlName)
        updateInteractionStatus()
    }

    func finishSpatialEvents() {
        // SwiftUI calls onEnded when the complete collection ends. Reset both
        // assignments as a final guard against a cancelled event being omitted.
        headEventID = nil
        actuatorEventID = nil
        elbowEventID = nil
        wristFlexEventID = nil
        wristRollEventID = nil
        selectControl(nil)
        isHeadGrabbed = false
        isActuatorGrabbed = false
        wristHand = nil
        wristInputSource = nil
        headIsolationJoint = nil
        lastHeadTargetUpdate = nil
        lastWristJointUpdate = nil
        latestSpatialWristOrientation = nil
        initialHandOrientation = nil
        reachSaturation = 0
        liftSaturation = 0
        wristFlexSaturation = 0
        wristRollSaturation = 0
        updateInteractionStatus()
    }

    var activeJointLabel: String {
        if singleJointMode { return activeIsolationJoint?.label ?? "Choose a control" }
        switch activeControlName {
        case "leader-head": return "End effector + wrist orientation"
        case "elbow-control": return "Shoulder lift (elbow held)"
        case "wrist-flex-control": return "Wrist flex"
        case "wrist-roll-control": return "Wrist roll"
        case "claw-actuator": return "Gripper"
        default: return "None"
        }
    }

    private var activeControlName: String? {
        if headEventID != nil { return "leader-head" }
        if elbowEventID != nil { return "elbow-control" }
        if wristFlexEventID != nil { return "wrist-flex-control" }
        if wristRollEventID != nil { return "wrist-roll-control" }
        if actuatorEventID != nil { return "claw-actuator" }
        return nil
    }

    private func selectControl(_ name: String?) {
        setOrbMaterial(headBulb, color: .systemPurple, selected: name == "leader-head")
        setOrbMaterial(elbowControl, color: .systemPurple, selected: name == "elbow-control")
        setOrbMaterial(wristFlexControl, color: .systemYellow, selected: name == "wrist-flex-control")
        setOrbMaterial(wristRollControl, color: .systemMint, selected: name == "wrist-roll-control")
        setOrbMaterial(actuator, color: .systemTeal, selected: name == "claw-actuator")
    }

    private func setOrbMaterial(_ orb: ModelEntity, color: UIColor, selected: Bool) {
        guard var model = orb.model else { return }
        model.materials = [
            SimpleMaterial(
                color: color.withAlphaComponent(selected ? 1 : 0.45),
                roughness: 0.2,
                isMetallic: true
            )
        ]
        orb.model = model
    }

    private func updateInteractionStatus() {
        if elbowEventID != nil {
            status = "Shoulder fold active — pull violet elbow control backward/forward"
        } else if wristFlexEventID != nil {
            status = "Wrist flex active — drag yellow control vertically"
        } else if wristRollEventID != nil {
            status = "Wrist roll active — drag mint control horizontally"
        } else {
            switch (isHeadGrabbed, isActuatorGrabbed) {
            case (true, true):
                status = "Both controls active — posing the arm and sliding the claw"
            case (true, false):
                status = "Leader head grabbed — constrained joints are following"
            case (false, true):
                status = "Claw ball grabbed — slide along the rail"
            case (false, false):
                status = "Ready — violet poses arm; yellow flexes wrist; mint rolls wrist"
            }
        }
    }

    private func setEndEffector(
        position requested: SIMD3<Float>,
        verticalBoundary: Int = 0
    ) {
        // Swivel the arm around the fixed base. The remaining IK is solved in
        // the arm's local vertical plane, so both links retain their lengths.
        let horizontal = SIMD2<Float>(requested.x - shoulderPosition.x, requested.z - shoulderPosition.z)
        let horizontalDistance = simd_length(horizontal)
        let baseYaw: Float = horizontalDistance > 0.0001 ? atan2(horizontal.y, -horizontal.x) : 0
        let planar = SIMD2<Float>(-horizontalDistance, requested.y - shoulderPosition.y)
        let requestedDistance = simd_length(planar)
        guard requestedDistance > 0.0001 else { return }

        let minimumReach = abs(upperArmLength - forearmLength) + 0.015
        let maximumReach = upperArmLength + forearmLength - 0.015
        let reach = max(minimumReach, min(maximumReach, requestedDistance))
        let direction = planar / requestedDistance
        let target = SIMD3<Float>(
            shoulderPosition.x + (direction.x * reach),
            shoulderPosition.y + (direction.y * reach),
            0
        )

        // This bend direction keeps the elbow on the intended side and avoids flips.
        let cosine = max(-1, min(1, (upperArmLength * upperArmLength + reach * reach - forearmLength * forearmLength) / (2 * upperArmLength * reach)))
        let shoulderAngle = atan2(direction.y, direction.x) - acos(cosine)
        let elbow = SIMD3<Float>(
            shoulderPosition.x + (upperArmLength * cos(shoulderAngle)),
            shoulderPosition.y + (upperArmLength * sin(shoulderAngle)),
            0
        )

        let forearmVector = target - elbow
        let forearmAngle = atan2(forearmVector.y, forearmVector.x)
        // Convert visual planar angles into the *calibrated SO-101 motor
        // angles*. At q=0 the CAD arm is neither horizontal nor a straight
        // generic two-link: see shoulderLiftZero/elbowWorldZero above.
        let requestedLift = normalizedAngle(shoulderAngle - shoulderLiftZero)
        let requestedElbow = normalizedAngle(forearmAngle - requestedLift - elbowWorldZero)
        let requestedPanMotor = clamped(baseYaw, minimum: -maxShoulderPan, maximum: maxShoulderPan)
        let requestedLiftMotor = clamped(requestedLift, minimum: -maxShoulderLift, maximum: maxShoulderLift)
        let requestedElbowMotor = clamped(requestedElbow, minimum: -maxElbowFlex, maximum: maxElbowFlex)
        let panMotor = allows(.shoulderPan) ? requestedPanMotor : virtualShoulderPan
        let liftMotor = allows(.shoulderLift) ? requestedLiftMotor : virtualShoulderLift
        let elbowMotor = allows(.elbowFlex) ? requestedElbowMotor : virtualElbowFlex

        // Pushing the violet ball past the reachable envelope continues the
        // matching physical elbow direction. The flag is evaluated against
        // motor-space q, not the old display-space link angle.
        if allows(.elbowFlex) {
            if requestedDistance < minimumReach - 0.001 {
                reachSaturation = requestedElbowMotor >= 0 ? 1 : -1
            } else if requestedDistance > maximumReach + 0.001 {
                reachSaturation = requestedElbowMotor >= 0 ? -1 : 1
            } else {
                reachSaturation = 0
            }
        } else {
            reachSaturation = 0
        }

        if allows(.shoulderLift) {
            switch verticalBoundary {
            case 1:
                liftSaturation = 1
            case -1:
                liftSaturation = 1
                if allows(.elbowFlex) { reachSaturation = 1 }
            default:
                liftSaturation = 0
            }
        } else {
            liftSaturation = 0
        }

        applyFollowerPose(
            shoulderPan: panMotor,
            shoulderLift: liftMotor,
            elbowFlex: elbowMotor,
            wristFlex: virtualWristFlex,
            wristRoll: virtualWristRoll
        )
    }

    /// Forward kinematics for the visual SO-101. All arguments are calibrated
    /// follower joint coordinates in radians, so a telemetry pose and an AVP
    /// command draw the same mechanism in the same configuration.
    private func applyFollowerPose(
        shoulderPan: Float,
        shoulderLift: Float,
        elbowFlex: Float,
        wristFlex: Float,
        wristRoll: Float,
        snap: Bool = false
    ) {
        let requestedPan = clamped(shoulderPan, minimum: -maxShoulderPan, maximum: maxShoulderPan)
        let requestedLift = clamped(shoulderLift, minimum: -maxShoulderLift, maximum: maxShoulderLift)
        let requestedElbow = clamped(elbowFlex, minimum: -maxElbowFlex, maximum: maxElbowFlex)
        let requestedWristFlex = clamped(wristFlex, minimum: -maxWristFlex, maximum: maxWristFlex)
        let requestedWristRoll = clamped(wristRoll, minimum: -maxWristRoll, maximum: maxWristRoll)
        let now = ProcessInfo.processInfo.systemUptime

        if snap || lastArmJointUpdate == nil {
            virtualShoulderPan = requestedPan
            virtualShoulderLift = requestedLift
            virtualElbowFlex = requestedElbow
        } else if let lastArmJointUpdate {
            let dt = cappedElapsed(now - lastArmJointUpdate)
            let step = maximumArmJointSpeedRadiansPerSecond * Float(dt)
            virtualShoulderPan = moved(virtualShoulderPan, toward: requestedPan, maximumStep: step)
            virtualShoulderLift = moved(virtualShoulderLift, toward: requestedLift, maximumStep: step)
            virtualElbowFlex = moved(virtualElbowFlex, toward: requestedElbow, maximumStep: step)
        }
        lastArmJointUpdate = now

        if snap || lastWristJointUpdate == nil {
            virtualWristFlex = requestedWristFlex
            virtualWristRoll = requestedWristRoll
        } else if let lastWristJointUpdate {
            let dt = cappedElapsed(now - lastWristJointUpdate)
            let step = maximumWristJointSpeedRadiansPerSecond * Float(dt)
            virtualWristFlex = moved(virtualWristFlex, toward: requestedWristFlex, maximumStep: step)
            virtualWristRoll = moved(virtualWristRoll, toward: requestedWristRoll, maximumStep: step)
        }
        lastWristJointUpdate = now

        // In the mirrored virtual plane, positive SO-101 shoulder/elbow motor
        // angles advance the world link angles from their CAD zero offsets.
        let upperAngle = shoulderLiftZero + virtualShoulderLift
        let forearmAngle = elbowWorldZero + virtualShoulderLift + virtualElbowFlex
        let elbow = shoulderPosition + SIMD3<Float>(
            upperArmLength * cos(upperAngle),
            upperArmLength * sin(upperAngle),
            0
        )
        let wrist = elbow + SIMD3<Float>(
            forearmLength * cos(forearmAngle),
            forearmLength * sin(forearmAngle),
            0
        )
        virtualForearmAngle = forearmAngle

        armAssembly.orientation = simd_quatf(angle: virtualShoulderPan, axis: [0, 1, 0])
        placeBeam(upperLink, from: shoulderPosition, to: elbow)
        elbowJoint.position = elbow
        elbowServo.position = elbow + SIMD3<Float>(0, 0.022, 0)
        // Put the pull handle behind the elbow *toward the shoulder/base*, not
        // on either side of the arm. It remains targetable above the upper arm.
        let towardBase = simd_normalize(shoulderPosition - elbow)
        // Stay on this proximal vector as shoulder pose changes: the orb is
        // always behind the elbow toward the base, never on a Z-side.
        elbowControl.position = elbow + (towardBase * 0.12)
        placeBeam(forearmLink, from: elbow, to: wrist)
        wristJoint.position = wrist
        wristServo.position = wrist + SIMD3<Float>(0, 0.022, 0)
        wristFlexPivot.position = wrist
        // Keep the violet arm-pose target above every compact wrist component.
        headBulb.position = wrist + SIMD3<Float>(0, 0.145, 0)
        // Place the yellow flex and mint roll targets well apart on opposite
        // sides of the wrist, so their enlarged collision volumes never make
        // individual pinches ambiguous.
        wristFlexControl.position = wrist + SIMD3<Float>(0, 0.090, 0.160)
        wristFlexAxisGuide.position = wristFlexControl.position
        wristRollControl.position = wrist + SIMD3<Float>(0, 0.090, -0.160)
        wristRollAxisGuide.position = wristRollControl.position
        updateWristPose()
    }

    private func updateWristPose() {
        // The pincer points along local -X. Subtracting π aligns that axis with
        // the forearm at zero flex; the nested roll pivot then drives the fifth
        // physical arm motor independently.
        wristFlexPivot.orientation = simd_quatf(
            angle: virtualForearmAngle + virtualWristFlex - .pi,
            axis: [0, 0, 1]
        )
        wristRollPivot.orientation = simd_quatf(angle: virtualWristRoll, axis: [1, 0, 0])
    }

    private func placeBeam(_ entity: ModelEntity, from start: SIMD3<Float>, to end: SIMD3<Float>) {
        let vector = end - start
        let length = simd_length(vector)
        guard length > 0.0001 else { return }
        entity.position = (start + end) / 2
        // The SO-101 printed beam meshes are long along their local X axis.
        entity.orientation = simd_quatf(from: SIMD3<Float>(1, 0, 0), to: vector / length)
    }

    private func setClaw(opening: Float, snap: Bool = false) {
        // LeRobot reports 0=closed and 100=open. Only the Moving_Jaw rotates;
        // the follower's Wrist_Roll_Follower jaw remains fixed. Rate-limit the
        // normalized jaw opening too, so an actuator event cannot jump it.
        let requestedOpening = max(0, min(1, opening))
        let now = ProcessInfo.processInfo.systemUptime
        if snap || lastGripperUpdate == nil {
            gripperOpening = requestedOpening
        } else if let lastGripperUpdate {
            let dt = cappedElapsed(now - lastGripperUpdate)
            let step = maximumGripperSpeedPerSecond * Float(dt)
            gripperOpening = moved(gripperOpening, toward: requestedOpening, maximumStep: step)
        }
        lastGripperUpdate = now
        let closedAngle: Float = 0.16
        let openAngle: Float = -0.78
        let angle = closedAngle + ((openAngle - closedAngle) * gripperOpening)
        upperClawPivot.orientation = simd_quatf(angle: angle, axis: [0, 0, 1])
        lowerClawPivot.orientation = simd_quatf(angle: 0, axis: [0, 0, 1])
    }

    private func clamped(_ value: Float, minimum: Float, maximum: Float) -> Float {
        min(maximum, max(minimum, value))
    }

    private func moved(_ value: Float, toward target: Float, maximumStep: Float) -> Float {
        value + clamped(target - value, minimum: -maximumStep, maximum: maximumStep)
    }

    /// A resume after a stalled event loop must not turn elapsed wall time into
    /// a giant joint step. 100 ms is enough to keep the input responsive while
    /// preserving every joint's configured radians/second cap.
    private func cappedElapsed(_ elapsed: TimeInterval) -> TimeInterval {
        min(0.10, max(0.001, elapsed))
    }

    private func normalizedAngle(_ angle: Float) -> Float {
        var result = angle.truncatingRemainder(dividingBy: 2 * .pi)
        if result > .pi { result -= 2 * .pi }
        if result < -.pi { result += 2 * .pi }
        return result
    }

    private func twistAngleAroundX(_ rotation: simd_quatf) -> Float {
        let projected = SIMD4<Float>(rotation.imag.x, 0, 0, rotation.real)
        let length = simd_length(projected)
        guard length > 0.0001 else { return 0 }
        let twist = projected / length
        return normalizedAngle(2 * atan2(twist.x, twist.w))
    }
}
