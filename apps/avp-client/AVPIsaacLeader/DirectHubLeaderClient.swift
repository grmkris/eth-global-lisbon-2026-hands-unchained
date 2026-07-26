import Foundation
import Observation

/// Direct Proof of Hands leader client for visionOS.
///
/// The browser owns the rig lease and chooses the rig. This client is only a
/// registered leader input device: it receives that binding through the leader
/// heartbeat, mirrors the rig telemetry into the virtual leader, and streams
/// safe, relative-clutched joint targets to the hub. It is the headset-native
/// replacement for `tools/hub_virtual_leader_gateway.py`; no Mac gateway,
/// Bonjour session, serial port, or local service is involved.
@MainActor
@Observable
final class DirectHubLeaderClient {
    struct Snapshot: Sendable {
        let connected: Bool
        let leaderName: String?
        let mode: String
        let message: String
        let armed: Bool
        let selectedRig: String?
        let leaderBound: Bool
        /// First two camera names advertised by the currently bound rig.
        let cameraNames: [String]
        /// Latest JPEG snapshots keyed by advertised camera name.
        let cameraFrames: [String: Data]
        let actual: [String: Double]
        let target: [String: Double]
    }

    private struct CommandSample {
        let command: VirtualLeaderCommand
        let receivedAt: TimeInterval
    }

    private static let bodyJoints = [
        "shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll",
    ]
    private static let allJoints = bodyJoints + ["gripper"]
    /// The headset model is mirrored to face its operator. Shoulder pan is
    /// therefore the one motor-space axis whose follower direction is inverse
    /// to its virtual display direction.
    private static let followerDirections: [String: Double] = [
        "shoulder_pan": -1,
    ]

    // These deliberately match the Mac gateway defaults. The receiving rig
    // still clips to its calibrated limits; our bounds prevent local target
    // windup while the rig reports a clipped joint.
    private let commandTimeout: TimeInterval = 0.5
    private let sourceFreshness: TimeInterval = 0.12
    // The visual leader already applies time-based caps. Keep a second,
    // independent hardware-boundary cap here, but do not reduce a live arm to
    // the old 8°/s crawl. This remains far below unrestricted servo motion.
    private let maxSpeedDegreesPerSecond = 25.0
    private let maxGripperSpeedPerSecond = 30.0
    private let edgeRateDegreesPerSecond = 25.0
    // A jerk-limited trajectory removes the low-pass filter's lag and avoids
    // the sharp starts/stops that made precision follower motion feel choppy.
    // These are still bounded below the independent per-joint speed limits.
    private let maxBodyAccelerationDegreesPerSecond2 = 100.0
    private let maxGripperAccelerationPerSecond2 = 140.0
    private let maxBodyJerkDegreesPerSecond3 = 700.0
    private let maxGripperJerkPerSecond3 = 1_000.0

    private(set) var isConnected = false
    private(set) var leaderName: String?
    private(set) var mode = "disconnected"
    private(set) var message = "Connect directly to the Proof of Hands hub"
    private(set) var armed = false
    private(set) var selectedRig: String?
    private(set) var leaderBound = false
    private(set) var actual = DirectHubLeaderClient.restPose
    private(set) var target = DirectHubLeaderClient.restPose

    var onSnapshot: (@MainActor @Sendable (Snapshot) -> Void)?

    private var baseURL: URL?
    private var token = ""
    private var clientID = ""
    private var controlPlaneTask: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var socketRetryAt: TimeInterval = 0
    private var latestCommand: CommandSample?
    private var armVirtualBase: [String: Double]?
    private var armPhysicalBase: [String: Double]?
    private var gripperVirtualBase: Double?
    private var gripperPhysicalBase: Double?
    private var trajectoryVelocity: [String: Double] = [:]
    private var trajectoryAcceleration: [String: Double] = [:]
    private var cameraNames: [String] = []
    private var cameraFrames: [String: Data] = [:]
    private var lastCameraRefresh: TimeInterval = 0
    /// An explicit, bounded move requested by “Move both to neutral”. It uses
    /// the exact same per-joint rate cap and target-lead guard as live input.
    private var neutralMovePending = false

    private static let restPose: [String: Double] = [
        "shoulder_pan": 0,
        "shoulder_lift": 0,
        "elbow_flex": 0,
        "wrist_flex": 0,
        "wrist_roll": 0,
        "gripper": 50,
    ]

    var canArm: Bool { isConnected && leaderBound && selectedRig != nil }
    var canOpenLeader: Bool { canArm }
    var canMoveToNeutral: Bool { canArm && armed }

    func connect(hubURL: String, token: String, leaderName: String) {
        disconnect(notifyHub: false)

        guard let url = Self.validHubURL(hubURL) else {
            mode = "fault"
            message = "Hub URL must start with http:// or https://"
            publishSnapshot()
            return
        }
        let cleanName = leaderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else {
            mode = "fault"
            message = "Enter a name for this Vision Pro leader"
            publishSnapshot()
            return
        }

        baseURL = url
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.leaderName = cleanName
        clientID = "avp-\(UUID().uuidString.lowercased())"
        isConnected = true
        mode = "connecting"
        message = "Registering \(cleanName) with the Proof of Hands hub"
        publishSnapshot()

        controlPlaneTask = Task { [weak self] in
            await self?.runControlPlane()
        }
        inputTask = Task { [weak self] in
            await self?.runInputLoop()
        }
    }

    func disconnect(notifyHub: Bool = true) {
        let shouldNotify = notifyHub && selectedRig != nil && leaderName != nil && baseURL != nil
        let priorName = leaderName
        let priorRig = selectedRig
        let priorClient = clientID
        let priorURL = baseURL
        let priorToken = token

        controlPlaneTask?.cancel()
        inputTask?.cancel()
        controlPlaneTask = nil
        inputTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        socketRetryAt = 0
        armed = false
        selectedRig = nil
        leaderBound = false
        latestCommand = nil
        clearClutches()
        cameraNames = []
        cameraFrames = [:]
        lastCameraRefresh = 0
        isConnected = false
        mode = "disconnected"
        message = "Disconnected from the Proof of Hands hub"
        baseURL = nil
        token = ""
        clientID = ""
        leaderName = nil
        publishSnapshot()

        // `stop` is safety-only and preserves the browser's lease. Fire it in
        // a detached task so closing the app never blocks the visionOS UI.
        if shouldNotify, let priorName, let priorRig, let priorURL {
            Task.detached {
                await Self.sendStop(
                    baseURL: priorURL,
                    token: priorToken,
                    leaderName: priorName,
                    clientID: priorClient,
                    rig: priorRig
                )
            }
        }
    }

    func arm() {
        guard canArm else {
            message = "Select this leader from a rig page in the web hub before arming"
            publishSnapshot()
            return
        }
        armed = true
        mode = "armed"
        message = "Armed on \(selectedRig ?? "rig"); grab a virtual control to move"
        target = actual
        clearClutches()
        publishSnapshot()
    }

    func moveToNeutral() {
        guard canMoveToNeutral else {
            message = "Arm the bound leader before moving both arms to neutral"
            publishSnapshot()
            return
        }
        // A manually held control always wins over a queued reset. It will
        // cancel this on its next fresh sample in nextInput.
        clearClutches()
        neutralMovePending = true
        mode = "neutral"
        message = "Moving both arms to calibrated neutral"
        publishSnapshot()
    }

    func stop() {
        armed = false
        latestCommand = nil
        clearClutches()
        mode = "disarmed"
        message = "Stop requested"
        publishSnapshot()
        guard let name = leaderName, let rig = selectedRig else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await request(
                    method: "POST",
                    path: "/api/hub/leaders/\(Self.pathComponent(name))/command",
                    body: ["clientId": clientID, "action": "stop", "rig": rig]
                )
            } catch {
                // A stop is local and immediate. The heartbeat's missing
                // binding still fails closed if this final network request dies.
                self.message = "Stopped locally; hub stop could not be confirmed"
                self.publishSnapshot()
            }
        }
    }

    func emergencyStop() {
        guard let rig = selectedRig else { return }
        armed = false
        latestCommand = nil
        clearClutches()
        mode = "stopping"
        message = "E-STOP requested"
        publishSnapshot()
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await request(
                    method: "POST",
                    path: "/api/hub/rigs/\(Self.pathComponent(rig))/command",
                    body: ["clientId": clientID, "verb": "estop"]
                )
                self.stop()
            } catch {
                self.mode = "fault"
                self.message = "E-STOP request failed: \(error.localizedDescription)"
                self.publishSnapshot()
            }
        }
    }

    /// The virtual-leader volume publishes at 30 Hz. This only stores the most
    /// recent pose; the separate input loop owns output cadence so networking
    /// can never stall RealityKit or hand tracking.
    func publish(_ command: VirtualLeaderCommand) {
        guard isConnected else { return }
        latestCommand = CommandSample(
            command: command,
            receivedAt: ProcessInfo.processInfo.systemUptime
        )
    }

    // MARK: - Leader heartbeat and binding

    private func runControlPlane() async {
        var lastRigRefresh: TimeInterval = 0
        var lastError = ""
        while !Task.isCancelled {
            do {
                try await updateLink()
                let now = ProcessInfo.processInfo.systemUptime
                // Target lead is measured from follower telemetry. Refresh it
                // at an active-control cadence; the old 1 Hz value made the
                // lead guard alternately stall and release, which felt choppy.
                let refreshInterval: TimeInterval = armed ? 0.125 : 1
                if selectedRig != nil && now - lastRigRefresh >= refreshInterval {
                    try await refreshSelectedRig()
                    lastRigRefresh = now
                }
                // JPEG snapshots are presentation-only: a late/missing camera
                // frame must never fault or delay the leader control channel.
                if selectedRig != nil, !cameraNames.isEmpty, now - lastCameraRefresh >= 0.33 {
                    await refreshCameraFrames()
                    lastCameraRefresh = now
                }
                lastError = ""
            } catch is CancellationError {
                return
            } catch {
                let detail = error.localizedDescription
                failClosed("Hub link failed: \(detail)")
                if detail != lastError {
                    lastError = detail
                }
            }
            try? await Task.sleep(for: .milliseconds(armed ? 125 : 500))
        }
    }

    private func updateLink() async throws {
        guard let name = leaderName else { throw HubClientError.notConfigured }
        let response = try await request(
            method: "POST",
            path: "/api/hub/leaders/link",
            body: ["name": name, "driving": selectedRig ?? NSNull()]
        )
        guard let object = response as? [String: Any] else { throw HubClientError.invalidResponse }
        let bound = object["bound"] as? Bool ?? false
        let command = object["command"] as? [String: Any]

        if command?["action"] as? String == "drive" {
            guard let rig = command?["rig"] as? String, !rig.isEmpty else {
                throw HubClientError.invalidResponse
            }
            selectedRig = rig
            leaderBound = bound
            armed = false
            latestCommand = nil
            clearClutches()
            mode = bound ? "bound" : "binding"
            message = bound
                ? "Web hub selected \(rig); press Arm"
                : "Waiting for web binding to \(rig)"
            publishSnapshot()
            try await refreshSelectedRig()
            target = actual
            publishSnapshot()
            return
        }

        if command?["action"] as? String == "stop" {
            clearBinding(message: "Stopped by the web hub")
            return
        }

        if selectedRig != nil && !bound {
            clearBinding(message: "Web binding to \(selectedRig ?? "rig") ended")
        } else if let rig = selectedRig {
            leaderBound = true
            if !armed {
                mode = "bound"
                message = "Web hub selected \(rig); press Arm"
            }
            publishSnapshot()
        } else {
            leaderBound = false
            mode = "waiting"
            message = "Waiting for this leader to be selected in the Proof of Hands web hub"
            publishSnapshot()
        }
    }

    private func refreshSelectedRig() async throws {
        guard let rig = selectedRig else { return }
        let response = try await request(
            method: "GET",
            path: "/api/hub/rigs/\(Self.pathComponent(rig))"
        )
        guard let object = response as? [String: Any] else { throw HubClientError.invalidResponse }
        guard object["online"] as? Bool ?? false else {
            throw HubClientError.rigOffline
        }
        let advertisedCameras = (object["cams"] as? [String] ?? [])
            .filter { !$0.isEmpty }
        let firstTwoCameras = Array(advertisedCameras.prefix(2))
        if firstTwoCameras != cameraNames {
            cameraNames = firstTwoCameras
            cameraFrames = cameraFrames.filter { firstTwoCameras.contains($0.key) }
            lastCameraRefresh = 0
        }

        let incoming = Self.normalizedJoints(object["joints"])
        guard !incoming.isEmpty else {
            publishSnapshot()
            return
        }
        for joint in Self.allJoints where incoming[joint] != nil {
            actual[joint] = incoming[joint]
        }
        if !armed { target = actual }
        publishSnapshot()
    }

    private func refreshCameraFrames() async {
        guard let rig = selectedRig else { return }
        var refreshed = cameraFrames
        var changed = false
        for camera in cameraNames {
            do {
                let data = try await requestImage(
                    path: "/api/hub/cams/\(Self.pathComponent(rig))/\(Self.pathComponent(camera))/snap"
                )
                guard !data.isEmpty else { continue }
                refreshed[camera] = data
                changed = true
            } catch {
                // Camera frame availability is independent from leader safety.
            }
        }
        if changed {
            cameraFrames = refreshed
            publishSnapshot()
        }
    }

    // MARK: - Motion and input transport

    private func runInputLoop() async {
        var lastMotionAt = ProcessInfo.processInfo.systemUptime
        var droppedSince: TimeInterval?
        while !Task.isCancelled {
            let now = ProcessInfo.processInfo.systemUptime
            let dt = min(0.25, max(0.001, now - lastMotionAt))
            lastMotionAt = now
            if let packet = nextInput(dt: dt) {
                do {
                    try await sendInput(rig: packet.rig, joints: packet.joints)
                    droppedSince = nil
                } catch is CancellationError {
                    return
                } catch {
                    // Latest-wins means a single dropped packet is harmless.
                    // Sustained transport failure disarms instead of allowing a
                    // stale virtual pose to resume after a partition.
                    droppedSince = droppedSince ?? now
                    if let firstDrop = droppedSince, now - firstDrop > 2 {
                        failClosed("Input stream down for 2 seconds")
                        droppedSince = nil
                    }
                }
            }
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    private func nextInput(dt: Double) -> (rig: String, joints: [String: Double])? {
        guard armed, leaderBound, let rig = selectedRig, let sample = latestCommand else { return nil }
        let age = ProcessInfo.processInfo.systemUptime - sample.receivedAt
        guard age <= commandTimeout else {
            armed = false
            mode = "timeout"
            message = "Vision Pro control timed out after \(Int(age * 1000)) ms"
            clearClutches()
            publishSnapshot()
            return nil
        }

        // A volume may stop refreshing while its last pose is active. Continue
        // sending a *hold* target, but never replay its active displacement.
        let fresh = age <= sourceFreshness
        let command = sample.command
        let armActive = fresh && command.armActive
        let gripperActive = fresh && command.gripperActive
        if neutralMovePending && (armActive || gripperActive) {
            neutralMovePending = false
            message = "Neutral move cancelled by virtual control"
        }
        var desired = target
        var active = neutralMovePending
        var edgeContinued = Set<String>()

        if neutralMovePending {
            // Calibrated joint zero is the SO-101's arm-neutral pose. Preserve
            // the current gripper target: moving to neutral must never drop an
            // object that is already being held.
            for joint in Self.bodyJoints {
                desired[joint] = Self.restPose[joint]
            }
        } else if armActive {
            active = true
            if armVirtualBase == nil {
                armVirtualBase = command.bodyRadians
                armPhysicalBase = target
            }
            guard var virtualBase = armVirtualBase, var physicalBase = armPhysicalBase else { return nil }
            for joint in Self.bodyJoints {
                let saturation = command.saturation[joint] ?? 0
                if saturation == -1 || saturation == 1 {
                    desired[joint] = target[joint, default: 0]
                        + Double(saturation) * edgeRateDegreesPerSecond * dt
                    virtualBase[joint] = command.bodyRadians[joint, default: 0]
                    edgeContinued.insert(joint)
                } else {
                    let delta = Self.wrappedDelta(
                        command.bodyRadians[joint, default: 0],
                        virtualBase[joint, default: 0]
                    )
                    let direction = Self.followerDirections[joint, default: 1]
                    desired[joint] = physicalBase[joint, default: 0]
                        + direction * delta * 180 / .pi
                }
            }
            armVirtualBase = virtualBase
            armPhysicalBase = physicalBase
        } else {
            armVirtualBase = nil
            armPhysicalBase = nil
        }

        if gripperActive && !neutralMovePending {
            active = true
            if gripperVirtualBase == nil {
                gripperVirtualBase = Double(command.gripper)
                gripperPhysicalBase = target["gripper", default: 50]
                desired["gripper"] = target["gripper", default: 50]
            }
            guard let virtualBase = gripperVirtualBase, let physicalBase = gripperPhysicalBase else { return nil }
            let saturation = command.saturation["gripper"] ?? 0
            if saturation == -1 || saturation == 1 {
                desired["gripper"] = target["gripper", default: 50]
                    + Double(saturation) * maxGripperSpeedPerSecond * dt
                gripperVirtualBase = Double(command.gripper)
                edgeContinued.insert("gripper")
            } else {
                desired["gripper"] = Self.endpointClutchedValue(
                    value: Double(command.gripper),
                    virtualBase: virtualBase,
                    physicalBase: physicalBase,
                    low: 0,
                    high: 100
                )
            }
        } else if !neutralMovePending {
            gripperVirtualBase = nil
            gripperPhysicalBase = nil
        }

        guard active else {
            mode = "armed"
            message = "Armed on \(rig); holding"
            publishSnapshot()
            return (rig, Self.inputJoints(target))
        }

        var limited: [String: Double] = [:]
        for joint in Self.allJoints {
            let low = joint == "gripper" ? 0.0 : -180.0
            let high = joint == "gripper" ? 100.0 : 180.0
            let wanted = desired[joint] ?? target[joint, default: 0]
            let bounded = min(high, max(low, wanted))
            let speed = joint == "gripper" ? maxGripperSpeedPerSecond : maxSpeedDegreesPerSecond
            let maxAcceleration = joint == "gripper"
                ? maxGripperAccelerationPerSecond2 : maxBodyAccelerationDegreesPerSecond2
            let maxJerk = joint == "gripper"
                ? maxGripperJerkPerSecond3 : maxBodyJerkDegreesPerSecond3
            let previous = target[joint, default: 0]
            let error = bounded - previous
            let priorVelocity = trajectoryVelocity[joint, default: 0]
            let priorAcceleration = trajectoryAcceleration[joint, default: 0]

            // Slow down as the target approaches so the commanded pose arrives
            // with zero velocity. Limit acceleration changes too, yielding a
            // jerk-limited S-curve rather than an abrupt rate-limited step.
            let stoppingSpeed = sqrt(2 * maxAcceleration * abs(error))
            let requestedVelocity = error == 0
                ? 0
                : (error > 0 ? 1 : -1) * min(speed, stoppingSpeed)
            let requestedAcceleration = min(
                maxAcceleration,
                max(-maxAcceleration, (requestedVelocity - priorVelocity) / dt)
            )
            let accelerationStep = maxJerk * dt
            let acceleration = priorAcceleration + min(
                accelerationStep,
                max(-accelerationStep, requestedAcceleration - priorAcceleration)
            )
            let velocity = min(
                speed,
                max(-speed, priorVelocity + acceleration * dt)
            )
            var stepped = previous + velocity * dt
            var nextVelocity = velocity
            var nextAcceleration = acceleration
            if abs(stepped - previous) >= abs(error) {
                stepped = bounded
                nextVelocity = 0
                nextAcceleration = 0
            }

            // Keep the commanded target inside a bounded window around live
            // telemetry. If the follower falls behind, reset the trajectory
            // state rather than storing velocity that would later jump ahead.
            let lead = max(joint == "gripper" ? 35 : 20, speed * 1.5)
            let anchor = actual[joint, default: previous]
            let guarded = min(anchor + lead, max(anchor - lead, stepped))
            if guarded != stepped {
                nextVelocity = 0
                nextAcceleration = 0
            }
            trajectoryVelocity[joint] = nextVelocity
            trajectoryAcceleration[joint] = nextAcceleration
            limited[joint] = guarded
        }
        target = limited
        if neutralMovePending,
           Self.bodyJoints.allSatisfy({ joint in
               abs((actual[joint] ?? target[joint] ?? 0) - (Self.restPose[joint] ?? 0)) < 1.5
           }) {
            neutralMovePending = false
            message = "Both leader and follower are at calibrated neutral"
        }
        for joint in edgeContinued {
            if joint == "gripper" {
                gripperPhysicalBase = limited[joint]
            } else {
                armPhysicalBase?[joint] = limited[joint]
            }
        }
        mode = "active"
        message = "Driving \(rig)"
        publishSnapshot()
        return (rig, Self.inputJoints(limited))
    }

    private func sendInput(rig: String, joints: [String: Double]) async throws {
        if ProcessInfo.processInfo.systemUptime >= socketRetryAt && socket == nil {
            openInputSocket()
        }
        if let socket {
            do {
                let data = try JSONSerialization.data(withJSONObject: [
                    "t": "input", "rig": rig, "joints": joints,
                    "sentAt": Int(Date().timeIntervalSince1970 * 1000),
                ])
                try await socket.send(.data(data))
                return
            } catch {
                socket.cancel(with: .abnormalClosure, reason: nil)
                self.socket = nil
                socketRetryAt = ProcessInfo.processInfo.systemUptime + 10
            }
        }
        _ = try await request(
            method: "POST",
            path: "/api/hub/rigs/\(Self.pathComponent(rig))/input",
            body: ["clientId": "leader-\(leaderName ?? "")", "joints": joints],
            timeout: 0.5
        )
    }

    private func openInputSocket() {
        guard let baseURL, let name = leaderName, var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return }
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        let prefix = baseURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = prefix.isEmpty ? "/api/hub/ws" : "/\(prefix)/api/hub/ws"
        components.queryItems = [
            URLQueryItem(name: "role", value: "leader"),
            URLQueryItem(name: "name", value: name),
        ]
        guard let url = components.url else { return }
        var request = URLRequest(url: url)
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        socketRetryAt = ProcessInfo.processInfo.systemUptime + 10
        task.resume()
    }

    // MARK: - HTTP helpers

    private func request(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        timeout: TimeInterval = 2
    ) async throws -> Any {
        guard let baseURL else { throw HubClientError.notConfigured }
        let suffix = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let url = baseURL.appendingPathComponent(suffix)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HubClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw HubClientError.http(http.statusCode, detail ?? "request failed")
        }
        return data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data)
    }

    private func requestImage(path: String) async throws -> Data {
        guard let baseURL else { throw HubClientError.notConfigured }
        let suffix = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var request = URLRequest(url: baseURL.appendingPathComponent(suffix))
        request.httpMethod = "GET"
        request.timeoutInterval = 0.75
        request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HubClientError.invalidResponse
        }
        return data
    }

    private static func sendStop(
        baseURL: URL,
        token: String,
        leaderName: String,
        clientID: String,
        rig: String
    ) async {
        let path = "api/hub/leaders/\(pathComponent(leaderName))/command"
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "clientId": clientID, "action": "stop", "rig": rig,
        ])
        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: - State and math

    private func clearBinding(message: String) {
        armed = false
        leaderBound = false
        selectedRig = nil
        cameraNames = []
        cameraFrames = [:]
        lastCameraRefresh = 0
        latestCommand = nil
        clearClutches()
        mode = "disarmed"
        self.message = message
        publishSnapshot()
    }

    private func failClosed(_ detail: String) {
        armed = false
        leaderBound = false
        latestCommand = nil
        clearClutches()
        mode = "fault"
        message = detail
        publishSnapshot()
    }

    private func clearClutches() {
        neutralMovePending = false
        armVirtualBase = nil
        armPhysicalBase = nil
        gripperVirtualBase = nil
        gripperPhysicalBase = nil
        trajectoryVelocity = [:]
        trajectoryAcceleration = [:]
    }

    private func publishSnapshot() {
        onSnapshot?(Snapshot(
            connected: isConnected,
            leaderName: leaderName,
            mode: mode,
            message: message,
            armed: armed,
            selectedRig: selectedRig,
            leaderBound: leaderBound,
            cameraNames: cameraNames,
            cameraFrames: cameraFrames,
            actual: actual,
            target: target
        ))
    }

    private static func validHubURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host != nil else { return nil }
        return url
    }

    private static func normalizedJoints(_ raw: Any?) -> [String: Double] {
        guard let dictionary = raw as? [String: Any] else { return [:] }
        return dictionary.reduce(into: [:]) { result, pair in
            let name = pair.key.hasSuffix(".pos") ? String(pair.key.dropLast(4)) : pair.key
            guard allJoints.contains(name), let value = pair.value as? NSNumber,
                  value.doubleValue.isFinite else { return }
            result[name] = value.doubleValue
        }
    }

    private static func inputJoints(_ joints: [String: Double]) -> [String: Double] {
        Dictionary(uniqueKeysWithValues: allJoints.map { ("\($0).pos", joints[$0, default: 0]) })
    }

    private static func pathComponent(_ name: String) -> String {
        name.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? name
    }

    private static func wrappedDelta(_ value: Double, _ origin: Double) -> Double {
        (value - origin + .pi).truncatingRemainder(dividingBy: 2 * .pi) - .pi
    }

    private static func endpointClutchedValue(
        value: Double,
        virtualBase: Double,
        physicalBase: Double,
        low: Double,
        high: Double
    ) -> Double {
        if value < virtualBase {
            let progress = virtualBase > 0 ? (virtualBase - value) / virtualBase : 0
            return physicalBase + (low - physicalBase) * min(1, max(0, progress))
        }
        if value > virtualBase {
            let remaining = 1 - virtualBase
            let progress = remaining > 0 ? (value - virtualBase) / remaining : 0
            return physicalBase + (high - physicalBase) * min(1, max(0, progress))
        }
        return physicalBase
    }
}

private extension VirtualLeaderCommand {
    var bodyRadians: [String: Double] {
        [
            "shoulder_pan": Double(shoulderPan),
            "shoulder_lift": Double(shoulderLift),
            "elbow_flex": Double(elbowFlex),
            "wrist_flex": Double(wristFlex),
            "wrist_roll": Double(wristRoll),
        ]
    }
}

private enum HubClientError: LocalizedError {
    case notConfigured
    case invalidResponse
    case rigOffline
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Hub is not configured"
        case .invalidResponse: "Hub returned an invalid response"
        case .rigOffline: "Selected rig is offline"
        case let .http(status, detail): "Hub HTTP \(status): \(detail)"
        }
    }
}
