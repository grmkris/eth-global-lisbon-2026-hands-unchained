import ARKit
import RealityKit
import SwiftUI

struct HandTrackingView: View {
    @Environment(HandTracker.self) private var handTracker

    var body: some View {
        RealityView { _ in }
            .task {
                await handTracker.start()
            }
    }
}

@Observable
@MainActor
final class HandTracker {
    private let session = ARKitSession()
    private let provider = HandTrackingProvider()
    private var updateTask: Task<Void, Never>?
    private var wristOrientations: [HandAnchor.Chirality: simd_quatf] = [:]
    private var pinchDistances: [HandAnchor.Chirality: Float] = [:]

    private(set) var isRunning = false
    private(set) var statusMessage = "Ready"

    func start() async {
        guard !isRunning else { return }

        do {
            try await session.run([provider])
            isRunning = true
            statusMessage = "Looking for hands…"
            updateTask = Task { [weak self] in
                guard let self else { return }
                for await update in provider.anchorUpdates {
                    guard !Task.isCancelled else { return }
                    switch update.event {
                    case .added, .updated:
                        self.updateHand(update.anchor)
                    case .removed:
                        self.removeHand(update.anchor.chirality)
                    }
                }
            }
        } catch {
            statusMessage = "Hand tracking is unavailable: \(error.localizedDescription)"
        }
    }

    private func updateHand(_ hand: HandAnchor) {
        guard hand.isTracked, let skeleton = hand.handSkeleton else {
            removeHand(hand.chirality)
            return
        }

        // The hand anchor can remain valid while ARKit marks the wrist joint
        // itself as inferred. Its transform still provides a useful wrist pose,
        // so don't gate orientation on Joint.isTracked.
        let wristTransform = hand.originFromAnchorTransform
            * skeleton.joint(.wrist).anchorFromJointTransform
        wristOrientations[hand.chirality] = simd_quatf(wristTransform)

        let thumb = skeleton.joint(.thumbTip)
        let index = skeleton.joint(.indexFingerTip)
        if thumb.isTracked, index.isTracked {
            let thumbTransform = hand.originFromAnchorTransform * thumb.anchorFromJointTransform
            let indexTransform = hand.originFromAnchorTransform * index.anchorFromJointTransform
            pinchDistances[hand.chirality] = simd_distance(
                position(from: thumbTransform),
                position(from: indexTransform)
            )
        }

        statusMessage = "Tracking \(hand.chirality == .left ? "left" : "right") hand"
    }

    func preferredPinchingHand() -> HandAnchor.Chirality? {
        // Prefer the most tightly pinched hand, but fall back to any tracked
        // wrist so the leader can report useful orientation diagnostics.
        pinchDistances.min(by: { $0.value < $1.value })?.key
            ?? wristOrientations.keys.first
    }

    func wristOrientation(for chirality: HandAnchor.Chirality) -> simd_quatf? {
        // Poll the provider as well as consuming its update stream. This avoids
        // a one-frame anchor-update race when a gesture begins.
        let anchors = provider.latestAnchors
        let latest = chirality == .left ? anchors.leftHand : anchors.rightHand
        if let latest, latest.isTracked {
            if let skeleton = latest.handSkeleton {
                let transform = latest.originFromAnchorTransform
                    * skeleton.joint(.wrist).anchorFromJointTransform
                return simd_quatf(transform)
            }
            return simd_quatf(latest.originFromAnchorTransform)
        }
        return wristOrientations[chirality]
    }

    private func removeHand(_ chirality: HandAnchor.Chirality) {
        wristOrientations[chirality] = nil
        pinchDistances[chirality] = nil
    }

    private func position(from transform: simd_float4x4) -> SIMD3<Float> {
        SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    }
}
