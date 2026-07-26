import Foundation
import Network
import Observation

struct VirtualLeaderCommand: Sendable {
    let shoulderPan: Float
    let shoulderLift: Float
    let elbowFlex: Float
    let wristFlex: Float
    let wristRoll: Float
    let gripper: Float
    let armActive: Bool
    let gripperActive: Bool
    /// Per-joint edge-continuation flags (-1/0/+1): the operator is holding a
    /// control past this virtual joint's envelope limit in that direction.
    let saturation: [String: Int]
}

/// Sends at most one control frame at a time from the network queue, so UI
/// rendering and telemetry cannot starve the gateway's transport watchdog. A command
/// that has not been refreshed by the leader view is sent with both clutches
/// released; stale UI state can therefore hold position, but can never replay
/// active motion.
private final class ControlFramePump: @unchecked Sendable {
    private struct Sample {
        let command: VirtualLeaderCommand
        let publishedAt: TimeInterval
    }

    private let queue: DispatchQueue
    private let lock = NSLock()
    private let sourceFreshness: TimeInterval = 0.12
    private var timer: DispatchSourceTimer?
    private var connection: NWConnection?
    private var latestSample: Sample?
    private var sequence = 0
    private var sendPending = false

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func start(connection: NWConnection) {
        stop()

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(4))
        timer.setEventHandler { [weak self, weak connection] in
            guard let connection else { return }
            self?.sendNext(on: connection)
        }

        lock.withLock {
            self.connection = connection
            latestSample = nil
            sequence = 0
            sendPending = false
            self.timer = timer
        }
        timer.resume()
    }

    func stop() {
        let timer = lock.withLock {
            let timer = self.timer
            self.timer = nil
            connection = nil
            latestSample = nil
            sequence = 0
            sendPending = false
            return timer
        }
        timer?.setEventHandler {}
        timer?.cancel()
    }

    func publish(_ command: VirtualLeaderCommand) {
        lock.withLock {
            latestSample = Sample(
                command: command,
                publishedAt: ProcessInfo.processInfo.systemUptime
            )
        }
    }

    private func sendNext(on connection: NWConnection) {
        let frame: (command: VirtualLeaderCommand, sequence: Int, active: Bool)? = lock.withLock {
            guard self.connection === connection, !sendPending, let sample = latestSample else {
                return nil
            }
            sequence += 1
            sendPending = true
            let isFresh = ProcessInfo.processInfo.systemUptime - sample.publishedAt <= sourceFreshness
            return (sample.command, sequence, isFresh)
        }
        guard let frame else { return }

        let command = frame.command
        let payload: [String: Any] = [
            "type": "control",
            "sequence": frame.sequence,
            "client_time": ProcessInfo.processInfo.systemUptime,
            "arm_active": frame.active && command.armActive,
            "gripper_active": frame.active && command.gripperActive,
            "joints_rad": [
                "shoulder_pan": Double(command.shoulderPan),
                "shoulder_lift": Double(command.shoulderLift),
                "elbow_flex": Double(command.elbowFlex),
                "wrist_flex": Double(command.wristFlex),
                "wrist_roll": Double(command.wristRoll),
            ],
            "gripper": Double(command.gripper),
            "saturated": frame.active ? command.saturation : [:],
        ]

        guard var data = try? JSONSerialization.data(withJSONObject: payload) else {
            clearPending(for: connection)
            return
        }
        data.append(0x0A)
        connection.send(content: data, completion: .contentProcessed { [weak self, weak connection] _ in
            guard let connection else { return }
            self?.clearPending(for: connection)
        })
    }

    private func clearPending(for connection: NWConnection) {
        lock.withLock {
            guard self.connection === connection else { return }
            sendPending = false
        }
    }
}

/// Discovers a Mac gateway and owns the persistent virtual-leader connection.
/// The current protocol is paired but intentionally limited to a trusted LAN;
/// a later production pass will add certificate-pinned TLS.
@MainActor
@Observable
final class RobotConnectionModel {
    struct Gateway: Identifiable, Hashable {
        let id: String
        let name: String
        let endpoint: NWEndpoint
        let interfaceName: String?
    }

    static let serviceType = "_so101-control._tcp"

    private(set) var gateways: [Gateway] = []
    private(set) var isSearching = false
    private(set) var searchStatus = "Search is stopped."
    private(set) var connectingGatewayID: String?
    private(set) var connectedGatewayID: String?
    private(set) var connectionStatus = "Not connected"

    private(set) var gatewayName = "Mac gateway"
    /// True when the Vision Pro itself is the hub leader. In this mode the
    /// app uses HTTPS + WebSocket directly; there is no Bonjour/Mac gateway.
    private(set) var isDirectHub = false
    private(set) var pairingRequired = false
    private(set) var isPaired = false
    private(set) var gatewayAllowsMotion = false
    private(set) var robotReady = false
    private(set) var dryRun = false
    private(set) var isHubGateway = false
    private(set) var hubLeaderName: String?
    private(set) var gatewayMode = "disconnected"
    private(set) var gatewayMessage = "Connect to a Mac gateway"
    /// True while the gateway is armed (or actively driving). The virtual
    /// leader must NEVER be re-synchronized to follower telemetry in this
    /// state: a pose-sync landing between spatial-gesture flaps erases the
    /// operator's accumulated displacement, and the clutch then re-bases at
    /// the snapped pose — pinning every command to telemetry ("arm ignores
    /// me"). Telemetry may reshape the input device only while disarmed.
    private(set) var robotArmed = false
    private(set) var actualJoints: [String: Double] = [:]
    private(set) var followerPoseRevision = 0
    private(set) var targetJoints: [String: Double] = [:]
    private(set) var selectedRigName: String?
    /// First two authenticated JPEG feeds advertised by the direct-hub rig.
    private(set) var hubCameraNames: [String] = []
    private(set) var hubCameraFrames: [String: Data] = [:]
    private(set) var leaderBound = false

    var canArm: Bool {
        connectedGatewayID != nil && isPaired && gatewayAllowsMotion && robotReady
            && (!isHubGateway || leaderBound)
    }

    var canOpenLeader: Bool {
        isPaired && robotReady && (!isHubGateway || leaderBound)
    }

    /// Only direct-hub leaders can execute the shared neutral trajectory. The
    /// legacy Mac protocol has no equivalent explicit command, so never fake a
    /// follower move by merely resetting the local rendering.
    var canMoveBothToNeutral: Bool {
        isDirectHub && directHub.canMoveToNeutral
    }

    @ObservationIgnored private let networkQueue = DispatchQueue(label: "eu.l13l.AVPIsaacLeader.connection")
    @ObservationIgnored private let directHub = DirectHubLeaderClient()
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var connection: NWConnection?
    @ObservationIgnored private var receiveBuffer = Data()
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var followerPoseSourceID: String?
    @ObservationIgnored private lazy var controlPump = ControlFramePump(queue: networkQueue)

    init() {
        directHub.onSnapshot = { [weak self] snapshot in
            self?.applyDirectHubSnapshot(snapshot)
        }
    }

    /// Connect Vision Pro directly to the Proof of Hands hub. The hub browser
    /// still owns rig selection and its lease; this headset only advertises a
    /// leader input device and follows the binding it receives.
    func connectDirectlyToHub(hubURL: String, token: String, leaderName: String) {
        disconnect()
        isDirectHub = true
        gatewayName = "Proof of Hands hub"
        directHub.connect(hubURL: hubURL, token: token, leaderName: leaderName)
    }

    func startSearch() {
        stopSearch(clearResults: true)

        let parameters = NWParameters.tcp
        let browser = NWBrowser(
            for: .bonjour(type: Self.serviceType, domain: "local."),
            using: parameters
        )
        self.browser = browser
        isSearching = true
        searchStatus = "Starting local-network search…"

        browser.stateUpdateHandler = { [weak self, weak browser] state in
            guard let browser else { return }
            Task { @MainActor [weak self] in
                self?.handleBrowserState(state, from: browser)
            }
        }
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
            guard let browser else { return }
            Task { @MainActor [weak self] in
                self?.updateGateways(from: results, browser: browser)
            }
        }
        browser.start(queue: networkQueue)
    }

    func stopSearch() {
        stopSearch(clearResults: false)
    }

    private func stopSearch(clearResults: Bool) {
        browser?.stateUpdateHandler = nil
        browser?.browseResultsChangedHandler = nil
        browser?.cancel()
        browser = nil
        isSearching = false
        if clearResults {
            gateways = []
        }
        searchStatus = "Search is stopped."
    }

    func connect(to gateway: Gateway) {
        disconnect()

        let connection = NWConnection(to: gateway.endpoint, using: .tcp)
        self.connection = connection
        connectingGatewayID = gateway.id
        connectionStatus = "Connecting to \(gateway.name)…"
        gatewayName = gateway.name

        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let connection else { return }
            Task { @MainActor [weak self] in
                self?.handleConnectionState(state, connection: connection, gateway: gateway)
            }
        }
        connection.start(queue: networkQueue)
    }

    func disconnect() {
        if isDirectHub {
            // Local stop/disarm happens synchronously; the client sends the
            // safety-only hub stop asynchronously so this call never blocks UI.
            isDirectHub = false
            directHub.disconnect()
        }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        receiveBuffer.removeAll(keepingCapacity: false)
        connectingGatewayID = nil
        connectedGatewayID = nil
        connectionStatus = "Not connected"
        pairingRequired = false
        isPaired = false
        gatewayAllowsMotion = false
        robotReady = false
        robotArmed = false
        dryRun = false
        isHubGateway = false
        hubLeaderName = nil
        isDirectHub = false
        gatewayMode = "disconnected"
        gatewayMessage = "Connect to a Mac gateway"
        actualJoints = [:]
        followerPoseSourceID = nil
        targetJoints = [:]
        selectedRigName = nil
        hubCameraNames = []
        hubCameraFrames = [:]
        leaderBound = false
        controlPump.stop()
    }

    func pair(code: String) {
        let cleaned = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count == 4, cleaned.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            connectionStatus = "Enter the four-digit pairing code shown on the Mac"
            return
        }
        sendJSON(["type": "pair", "code": cleaned])
        connectionStatus = "Pairing with \(gatewayName)…"
    }

    func armRobot() {
        if isDirectHub {
            directHub.arm()
            return
        }
        guard canArm else {
            connectionStatus = "Pair with a ready, motion-enabled gateway first"
            return
        }
        sendJSON(["type": "arm"])
    }

    func moveBothToNeutral() {
        guard isDirectHub else { return }
        directHub.moveToNeutral()
    }

    func stopRobot() {
        if isDirectHub {
            directHub.stop()
            return
        }
        guard connection != nil else { return }
        sendJSON(["type": "stop"])
        gatewayMode = "stopping"
        gatewayMessage = "Stop requested"
    }

    func emergencyStop() {
        if isDirectHub {
            directHub.emergencyStop()
            return
        }
        guard isPaired, isHubGateway, selectedRigName != nil else { return }
        sendJSON(["type": "estop"])
        gatewayMode = "stopping"
        gatewayMessage = "Emergency stop requested"
    }

    func sendControl(_ command: VirtualLeaderCommand) {
        if isDirectHub {
            directHub.publish(command)
            return
        }
        guard isPaired, connection != nil else { return }
        controlPump.publish(command)
    }

    private func handleBrowserState(_ state: NWBrowser.State, from browser: NWBrowser) {
        guard self.browser === browser else { return }

        switch state {
        case .setup:
            searchStatus = "Preparing local-network search…"
        case .ready:
            searchStatus = gateways.isEmpty
                ? "Searching for SO-101 Mac gateways…"
                : foundStatus
        case .waiting(let error):
            searchStatus = "Search waiting: \(error.localizedDescription)"
        case .failed(let error):
            searchStatus = "Search failed: \(error.localizedDescription)"
            isSearching = false
        case .cancelled:
            searchStatus = "Search is stopped."
            isSearching = false
        @unknown default:
            searchStatus = "Unknown search state"
        }
    }

    private func updateGateways(from results: Set<NWBrowser.Result>, browser: NWBrowser) {
        guard self.browser === browser else { return }

        gateways = results.compactMap { result in
            guard case let .service(name, type, domain, interface) = result.endpoint else {
                return nil
            }
            let interfaceName = interface?.name ?? result.interfaces.first?.name
            return Gateway(
                id: "\(name)|\(type)|\(domain)|\(interfaceName ?? "any")",
                name: name,
                endpoint: result.endpoint,
                interfaceName: interfaceName
            )
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        searchStatus = gateways.isEmpty
            ? "Searching for SO-101 Mac gateways…"
            : foundStatus
    }

    private var foundStatus: String {
        "Found \(gateways.count) gateway\(gateways.count == 1 ? "" : "s")"
    }

    private func handleConnectionState(
        _ state: NWConnection.State,
        connection: NWConnection,
        gateway: Gateway
    ) {
        guard self.connection === connection else { return }

        switch state {
        case .setup, .preparing:
            connectionStatus = "Connecting to \(gateway.name)…"
        case .ready:
            connectingGatewayID = nil
            connectedGatewayID = gateway.id
            connectionStatus = "Connected; waiting for gateway hello…"
            receiveMessages(on: connection)
            sendJSON([
                "type": "hello",
                "protocol": 1,
                "client": "AVPIsaacLeader",
            ])
        case .waiting(let error):
            connectionStatus = "Connection waiting: \(error.localizedDescription)"
        case .failed(let error):
            connectionStatus = "Connection failed: \(error.localizedDescription)"
            resetAfterConnectionLoss(connection)
        case .cancelled:
            connectionStatus = "Disconnected"
            resetAfterConnectionLoss(connection)
        @unknown default:
            connectionStatus = "Unknown connection state"
        }
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled, let self, self.connection != nil else { return }
                self.sendJSON(["type": "heartbeat"])
            }
        }
    }

    private func sendJSON(_ payload: [String: Any]) {
        guard let connection else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: payload)
            data.append(0x0A)
            connection.send(content: data, completion: .contentProcessed { [weak self, weak connection] error in
                guard let connection else { return }
                Task { @MainActor [weak self] in
                    guard let self, self.connection === connection else { return }
                    if let error {
                        self.connectionStatus = "Send failed: \(error.localizedDescription)"
                    }
                }
            })
        } catch {
            connectionStatus = "Could not encode message: \(error.localizedDescription)"
        }
    }

    private func receiveMessages(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self, weak connection] data, _, isComplete, error in
            guard let connection else { return }
            Task { @MainActor [weak self] in
                guard let self, self.connection === connection else { return }

                if let data, !data.isEmpty {
                    self.receiveBuffer.append(data)
                    self.processReceivedLines()
                }
                if let error {
                    self.connectionStatus = "Receive failed: \(error.localizedDescription)"
                    self.resetAfterConnectionLoss(connection)
                    return
                }
                if isComplete {
                    self.connectionStatus = "Gateway closed the connection"
                    self.resetAfterConnectionLoss(connection)
                    return
                }
                self.receiveMessages(on: connection)
            }
        }
    }

    private func processReceivedLines() {
        let newline = Data([0x0A])
        while let range = receiveBuffer.range(of: newline) {
            let line = receiveBuffer[..<range.lowerBound]
            receiveBuffer.removeSubrange(..<range.upperBound)
            guard !line.isEmpty else { continue }

            do {
                let object = try JSONSerialization.jsonObject(with: Data(line))
                guard let message = object as? [String: Any] else { continue }
                handleGatewayMessage(message)
            } catch {
                connectionStatus = "Invalid gateway message: \(error.localizedDescription)"
            }
        }
        if receiveBuffer.count > 65_536 {
            connectionStatus = "Gateway message exceeded 64 KiB"
            disconnect()
        }
    }

    private func handleGatewayMessage(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "gateway_hello":
            gatewayName = message["gateway"] as? String ?? gatewayName
            pairingRequired = message["pairing_required"] as? Bool ?? false
            gatewayAllowsMotion = message["allow_motion"] as? Bool ?? false
            robotReady = message["robot_ready"] as? Bool ?? false
            dryRun = message["dry_run"] as? Bool ?? false
            isHubGateway = message["mode"] as? String == "hub-leader"
            hubLeaderName = isHubGateway ? message["leader_name"] as? String : nil
            let isTestBeacon = message["robot_control"] as? Bool == false
            if isTestBeacon {
                connectionStatus = "\(gatewayName) replied — discovery test passed"
                gatewayMessage = "Test beacon only; start the virtual leader bridge for teleoperation"
            } else if pairingRequired {
                connectionStatus = "Connected to \(gatewayName); enter its four-digit pairing code"
                gatewayMessage = "Pairing required"
            } else {
                connectionStatus = "Connected to \(gatewayName)"
            }

        case "paired":
            isPaired = true
            robotReady = message["robot_ready"] as? Bool ?? robotReady
            gatewayAllowsMotion = message["allow_motion"] as? Bool ?? gatewayAllowsMotion
            connectionStatus = "Paired with \(gatewayName)"
            gatewayMessage = "Paired; robot remains disarmed"
            if let connection {
                controlPump.start(connection: connection)
            }
            startHeartbeat()

        case "state":
            gatewayMode = message["mode"] as? String ?? gatewayMode
            gatewayMessage = message["message"] as? String ?? gatewayMessage
            gatewayAllowsMotion = message["allow_motion"] as? Bool ?? gatewayAllowsMotion
            robotReady = message["robot_ready"] as? Bool ?? robotReady
            robotArmed = message["armed"] as? Bool ?? robotArmed
            dryRun = message["dry_run"] as? Bool ?? dryRun
            let incomingActual = numericDictionary(message["actual"])
            let incomingRig = message["selected_rig"] as? String
            actualJoints = incomingActual
            targetJoints = numericDictionary(message["target"])
            selectedRigName = incomingRig
            leaderBound = message["leader_bound"] as? Bool ?? leaderBound

            let poseSourceID: String?
            if isHubGateway, let incomingRig, leaderBound {
                poseSourceID = "rig:\(incomingRig)"
            } else if !isHubGateway, robotReady, let connectedGatewayID {
                poseSourceID = "gateway:\(connectedGatewayID)"
            } else {
                poseSourceID = nil
            }
            if poseSourceID == nil {
                followerPoseSourceID = nil
            } else if !incomingActual.isEmpty,
                      poseSourceID != followerPoseSourceID {
                followerPoseSourceID = poseSourceID
                followerPoseRevision += 1
            }
            connectionStatus = "\(gatewayName): \(gatewayMode)"

        case "error":
            let detail = message["message"] as? String ?? "Unknown gateway error"
            connectionStatus = "Gateway error: \(detail)"
            gatewayMessage = detail

        default:
            break
        }
    }

    private func numericDictionary(_ value: Any?) -> [String: Double] {
        guard let dictionary = value as? [String: Any] else { return [:] }
        return dictionary.reduce(into: [:]) { result, item in
            if let number = item.value as? NSNumber {
                result[item.key] = number.doubleValue
            }
        }
    }

    private func applyDirectHubSnapshot(_ snapshot: DirectHubLeaderClient.Snapshot) {
        guard isDirectHub else { return }
        connectedGatewayID = snapshot.connected ? "direct-hub" : nil
        connectingGatewayID = nil
        connectionStatus = "Proof of Hands hub: \(snapshot.mode)"
        gatewayMessage = snapshot.message
        pairingRequired = false
        isPaired = snapshot.connected
        gatewayAllowsMotion = snapshot.connected
        robotReady = snapshot.leaderBound && snapshot.selectedRig != nil
        robotArmed = snapshot.armed
        dryRun = false
        isHubGateway = true
        hubLeaderName = snapshot.leaderName
        gatewayMode = snapshot.mode
        targetJoints = snapshot.target
        leaderBound = snapshot.leaderBound
        selectedRigName = snapshot.selectedRig
        hubCameraNames = snapshot.cameraNames
        hubCameraFrames = snapshot.cameraFrames

        let sourceID = snapshot.leaderBound ? snapshot.selectedRig.map { "rig:\($0)" } : nil
        if sourceID == nil {
            followerPoseSourceID = nil
        } else if !snapshot.actual.isEmpty, sourceID != followerPoseSourceID {
            followerPoseSourceID = sourceID
            followerPoseRevision += 1
        }
        actualJoints = snapshot.actual
    }

    private func resetAfterConnectionLoss(_ connection: NWConnection) {
        guard self.connection === connection else { return }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        self.connection = nil
        connectingGatewayID = nil
        connectedGatewayID = nil
        pairingRequired = false
        isPaired = false
        gatewayAllowsMotion = false
        robotReady = false
        robotArmed = false
        isHubGateway = false
        hubLeaderName = nil
        gatewayMode = "disconnected"
        gatewayMessage = "Connection lost; the Mac gateway will disarm"
        selectedRigName = nil
        hubCameraNames = []
        hubCameraFrames = [:]
        leaderBound = false
        followerPoseSourceID = nil
        controlPump.stop()
    }
}
