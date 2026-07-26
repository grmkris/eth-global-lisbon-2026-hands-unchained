import SwiftUI

struct ControlView: View {
    @Environment(HandTracker.self) private var handTracker
    @Environment(RobotConnectionModel.self) private var connection
    @Environment(LeaderWindowState.self) private var leaderWindow
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var pairingCode = ""
    @AppStorage("directHubURL") private var directHubURL = "https://web-production-b5106.up.railway.app"
    @AppStorage("directHubLeaderName") private var directHubLeaderName = "vision-pro-avp"
    @State private var directHubToken = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "move.3d")
                    .font(.system(size: 54))
                    .foregroundStyle(.cyan)
                Text("AVP Isaac Leader").font(.largeTitle)
                Text(connection.isHubGateway
                     ? "Select this leader from the Hands Unchained web hub; the AVP follows that binding automatically."
                     : "Connect directly to the Hands Unchained hub, or to an optional local SO-101 gateway.")
                    .foregroundStyle(.secondary)

                directHubCard
                gatewayCard
                if connection.isPaired {
                    if connection.isHubGateway {
                        hubBindingCard
                    } else {
                        directFollowerCard
                    }
                }

                Button("Open Virtual Leader") {
                    openOrRepositionLeader()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!connection.canOpenLeader)

                Text(handTracker.statusMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(32)
        }
        .onAppear { leaderWindow.controlDidAppear() }
        .onDisappear { leaderWindow.controlDidDisappear() }
    }

    private func openOrRepositionLeader() {
        // A second request deliberately replaces an already-open volume. This
        // returns an offscreen leader to the utility placement near the user
        // while preserving the visionOS-2 singleton guarantee.
        if leaderWindow.beginRepositioning() {
            dismissWindow(id: AppWindow.leaderPlatform.rawValue)
            Task {
                try? await Task.sleep(for: .milliseconds(150))
                guard leaderWindow.beginOpening() else { return }
                openWindow(id: AppWindow.leaderPlatform.rawValue)
            }
        } else if leaderWindow.beginOpening() {
            openWindow(id: AppWindow.leaderPlatform.rawValue)
        }

        // Never make the visible leader volume wait for ARKit's immersive-space
        // activation. This request can wait on physical-headset scene state.
        if !handTracker.isRunning {
            Task {
                await openImmersiveSpace(id: "hand-tracking")
            }
        }
    }

    private var gatewayCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Mac gateway (optional)", systemImage: "laptopcomputer").font(.headline)
                Spacer()
                Button(connection.isSearching ? "Stop Search" : "Search") {
                    connection.isSearching ? connection.stopSearch() : connection.startSearch()
                }
            }
            Text(connection.searchStatus).font(.caption).foregroundStyle(.secondary)

            ForEach(connection.gateways) { gateway in
                HStack {
                    Image(systemName: "laptopcomputer").foregroundStyle(.cyan)
                    VStack(alignment: .leading) {
                        Text(gateway.name).font(.callout.weight(.semibold))
                        Text(gateway.interfaceName ?? RobotConnectionModel.serviceType)
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if connection.connectedGatewayID == gateway.id {
                        Button("Disconnect") { connection.disconnect() }
                    } else if connection.connectingGatewayID == gateway.id {
                        ProgressView()
                    } else {
                        Button("Connect") {
                            pairingCode = ""
                            connection.connect(to: gateway)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .padding(10)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            }

            if connection.connectedGatewayID != nil,
               connection.pairingRequired && !connection.isPaired {
                HStack {
                    TextField("4-digit Mac code", text: $pairingCode)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)
                        .frame(maxWidth: 220)
                        .onChange(of: pairingCode) { _, value in
                            pairingCode = String(value.filter { $0.isASCII && $0.isNumber }.prefix(4))
                        }
                    Button("Pair") { connection.pair(code: pairingCode) }
                        .buttonStyle(.borderedProminent)
                        .disabled(pairingCode.count != 4)
                }
            }

            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 9, height: 9)
                Text(connection.connectionStatus).font(.caption)
            }
            Text(connection.gatewayMessage).font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .glassBackgroundEffect()
    }

    private var directHubCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Hands Unchained hub", systemImage: "network").font(.headline)
            Text("Run this Vision Pro as a hub leader directly — no MacBook or Bonjour gateway. Rig selection and the control lease remain in the web hub.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if connection.isDirectHub {
                HStack {
                    Image(systemName: "visionpro").foregroundStyle(.cyan)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(connection.hubLeaderName ?? directHubLeaderName)
                            .font(.callout.weight(.semibold))
                        Text(connection.connectionStatus)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Disconnect") { connection.disconnect() }
                }
            } else {
                TextField("Hub URL", text: $directHubURL)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Leader name", text: $directHubLeaderName)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Hub token (only if required)", text: $directHubToken)
                    .textFieldStyle(.roundedBorder)
                Button("Connect directly to hub") {
                    connection.connectDirectlyToHub(
                        hubURL: directHubURL,
                        token: directHubToken,
                        leaderName: directHubLeaderName
                    )
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(16)
        .glassBackgroundEffect()
    }

    private var directFollowerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Local follower", systemImage: "point.3.connected.trianglepath.dotted")
                .font(.headline)
            Text("The virtual leader synchronizes to the measured follower pose before arming.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button("Arm") { connection.armRobot() }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                    .disabled(!connection.canArm)
                Spacer()
                Button("Stop") { connection.stopRobot() }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
            }
        }
        .padding(16)
        .glassBackgroundEffect()
    }

    private var hubBindingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Web hub binding", systemImage: "link").font(.headline)

            if let rigName = connection.selectedRigName {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(rigName).font(.callout.weight(.semibold))
                        Text(connection.leaderBound ? "Selected by web hub" : "Binding…")
                            .font(.caption2.monospaced())
                            .foregroundStyle(connection.leaderBound ? .green : .orange)
                    }
                    Spacer()
                    if !connection.leaderBound { ProgressView() }
                }

                Text("Rig selection and lease ownership stay in the web interface.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(connection.hubLeaderName.map {
                        "In the web hub, select “\($0)” from the rig page."
                    } ?? "Waiting for this leader to be selected from a rig page in the web hub.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Button("Arm") { connection.armRobot() }
                    .buttonStyle(.borderedProminent).tint(.orange)
                    .disabled(!connection.canArm)
                Spacer()
                HStack(spacing: 8) {
                    Button("Stop") { connection.stopRobot() }
                        .buttonStyle(.borderedProminent).tint(.red)
                        .disabled(connection.selectedRigName == nil)
                    Button("E-STOP") { connection.emergencyStop() }
                        .buttonStyle(.borderedProminent).tint(.red)
                        .disabled(connection.selectedRigName == nil)
                }
            }
        }
        .padding(16)
        .glassBackgroundEffect()
    }

    private var statusColor: Color {
        switch connection.gatewayMode {
        case "active": .green
        case "armed", "bound": .orange
        case "fault", "timeout": .red
        default: connection.isPaired ? .yellow : .secondary
        }
    }
}
