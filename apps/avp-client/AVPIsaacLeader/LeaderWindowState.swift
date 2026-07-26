import Observation

/// Process-wide singleton gates for the settings window and leader volume.
///
/// `WindowGroup` is the visionOS-2-compatible scene API, but every
/// `openWindow(id:)` call may create another instance. Set each gate before a
/// request so repeated taps cannot race duplicate scenes into existence.
@MainActor
@Observable
final class LeaderWindowState {
    private(set) var isOpen = false
    private(set) var isControlOpen = false

    /// Returns true only for the one caller that may request the volume.
    func beginOpening() -> Bool {
        guard !isOpen else { return false }
        isOpen = true
        return true
    }

    func didAppear() {
        isOpen = true
    }

    func didDisappear() {
        isOpen = false
    }

    /// Clears the leader gate before dismissing it, allowing one replacement
    /// volume to open at the scene's default placement in front of the user.
    func beginRepositioning() -> Bool {
        guard isOpen else { return false }
        isOpen = false
        return true
    }

    func beginControlOpening() -> Bool {
        guard !isControlOpen else { return false }
        isControlOpen = true
        return true
    }

    func controlDidAppear() {
        isControlOpen = true
    }

    func controlDidDisappear() {
        isControlOpen = false
    }
}
