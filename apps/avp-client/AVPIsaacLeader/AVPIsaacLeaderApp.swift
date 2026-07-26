import SwiftUI

enum AppWindow: String, Codable, Hashable {
    case controlPanel = "control-panel"
    case leaderPlatform = "leader-platform"
}

@main
struct AVPIsaacLeaderApp: App {
    @State private var handTracker = HandTracker()
    @State private var robotConnection = RobotConnectionModel()
    @State private var leaderWindow = LeaderWindowState()

    var body: some Scene {
        WindowGroup(id: AppWindow.controlPanel.rawValue, for: AppWindow.self) { _ in
            ControlView()
                .environment(handTracker)
                .environment(robotConnection)
                .environment(leaderWindow)
        } defaultValue: {
            .controlPanel
        }
        ImmersiveSpace(id: "hand-tracking") {
            HandTrackingView()
                .environment(handTracker)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)

        // The leader is a single visible volume, not a document/value scene.
        // Keeping it untyped lets `openWindow(id:)` create it immediately,
        // independently of the hand-tracking immersive-space activation.
        WindowGroup(id: AppWindow.leaderPlatform.rawValue) {
            VirtualLeaderView()
                .environment(handTracker)
                .environment(robotConnection)
                .environment(leaderWindow)
        }
        .windowStyle(.volumetric)
        // A replacement volume uses the system utility placement, bringing a
        // lost/offscreen leader back into the user's current view.
        .defaultWindowPlacement { _, _ in
            WindowPlacement(.utilityPanel)
        }
        // Room for the half-scale leader, enlarged grab controls, and a full
        // platform yaw without clipping against the volumetric window edges.
        .defaultSize(width: 1.3, height: 1.2, depth: 0.9, in: .meters)
    }
}
