import AppKit
import Foundation

// A short-lived presentation process. The Obsidian plugin owns all timer state.
// Stdin is newline-delimited JSON; closing stdin or missing heartbeats exits.
final class BlackoutWindow: NSWindow {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onEscape?()
        } else {
            super.keyDown(with: event)
        }
    }
}

final class OverlayController: NSObject, NSApplicationDelegate {
    private struct DisplayOverlay {
        var screen: NSScreen
        let window: BlackoutWindow
        let label: NSTextField
        let title: NSTextField
        let countdown: NSTextField
    }

    private var overlays: [String: DisplayOverlay] = [:]
    private var previousApp: NSRunningApplication?
    private var labelText = "现在应该做什么"
    private var titleText = ""
    private var remainingMilliseconds = 0.0
    private var countdownUpdatedAt = Date()
    private var paused = false
    private var lastHeartbeat = Date()
    private var finished = false
    private var heartbeatTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenConfigurationChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        heartbeatTimer = Timer.scheduledTimer(timeInterval: 0.2, target: self,
                                               selector: #selector(tick), userInfo: nil, repeats: true)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                DispatchQueue.main.async { self?.handle(line: line) }
            }
            DispatchQueue.main.async { self?.terminate() }
        }
        send(["type": "ready"])
    }

    private func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }

    private func handle(line: String) {
        guard let data = line.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let command = message["type"] as? String else { return }
        lastHeartbeat = Date()
        if command == "hide" || command == "shutdown" {
            terminate()
            return
        }
        guard command == "show" || command == "update" else { return }
        let created = overlays.isEmpty
        if let value = message["label"] as? String { labelText = value }
        if let value = message["title"] as? String { titleText = value }
        if let value = message["leftMs"] as? Double, value.isFinite {
            remainingMilliseconds = max(0, value)
            countdownUpdatedAt = Date()
        }
        paused = message["paused"] as? Bool ?? false

        guard synchronizeDisplays() else {
            send(["type": "error", "message": "No display available"])
            terminate()
            return
        }
        updateOverlayText()
        updateCountdown()
        if remainingMilliseconds <= 0 && !finished {
            finished = true
            flashOnce()
        }
        if created {
            send(["type": "shown", "screenCount": overlays.count,
                  "screens": overlays.values.map { $0.screen.localizedName }])
        }
    }

    private func displayIdentifier(_ screen: NSScreen) -> String {
        if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            return "display-\(number.uint32Value)"
        }
        return "\(screen.localizedName)-\(NSStringFromRect(screen.frame))"
    }

    private func createOverlay(for screen: NSScreen) -> DisplayOverlay {
        let overlay = BlackoutWindow(contentRect: screen.frame, styleMask: [.borderless],
                                     backing: .buffered, defer: false)
        overlay.level = .screenSaver
        overlay.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary]
        let reduceTransparency = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        overlay.isOpaque = reduceTransparency
        overlay.backgroundColor = reduceTransparency ? .black : NSColor.black.withAlphaComponent(0.97)
        overlay.hasShadow = false
        overlay.isReleasedWhenClosed = false
        overlay.onEscape = { [weak self] in self?.dismiss() }

        let content = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        overlay.contentView = content
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)

        let label = makeText(size: 17, weight: .medium, color: NSColor.white.withAlphaComponent(0.72))
        let title = makeText(size: 68, weight: .bold, color: .white)
        let countdown = makeText(size: 52, weight: .medium, color: NSColor.white.withAlphaComponent(0.88))
        countdown.font = NSFont.monospacedDigitSystemFont(ofSize: 52, weight: .medium)
        [label, title, countdown].forEach { stack.addArrangedSubview($0) }

        let exitButton = NSButton(title: "立即退出（计时继续）", target: self, action: #selector(exitClicked))
        exitButton.isBordered = false
        exitButton.attributedTitle = NSAttributedString(string: "立即退出（计时继续）", attributes: [
            .font: NSFont.systemFont(ofSize: 15, weight: .medium),
            .foregroundColor: NSColor.white
        ])
        exitButton.setButtonType(.momentaryPushIn)
        exitButton.wantsLayer = true
        exitButton.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.09).cgColor
        exitButton.layer?.borderColor = NSColor.white.withAlphaComponent(0.52).cgColor
        exitButton.layer?.borderWidth = 1
        exitButton.layer?.cornerRadius = 12
        exitButton.setAccessibilityLabel("立即退出黑屏，计时继续")
        exitButton.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(exitButton)
        stack.setCustomSpacing(30, after: countdown)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -32),
            title.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, multiplier: 0.82),
            exitButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 224),
            exitButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        label.stringValue = labelText
        title.stringValue = titleText
        return DisplayOverlay(screen: screen, window: overlay, label: label,
                              title: title, countdown: countdown)
    }

    @discardableResult
    private func synchronizeDisplays() -> Bool {
        let hadOverlays = !overlays.isEmpty
        let screens = NSScreen.screens
        guard !screens.isEmpty else {
            overlays.values.forEach {
                $0.window.orderOut(nil)
                $0.window.close()
            }
            overlays.removeAll()
            return false
        }

        if !hadOverlays { previousApp = NSWorkspace.shared.frontmostApplication }
        var displaysChanged = !hadOverlays
        let visibleIDs = Set(screens.map(displayIdentifier))
        for id in overlays.keys.filter({ !visibleIDs.contains($0) }) {
            overlays[id]?.window.orderOut(nil)
            overlays[id]?.window.close()
            overlays.removeValue(forKey: id)
            displaysChanged = true
        }
        for screen in screens {
            let id = displayIdentifier(screen)
            if var existing = overlays[id] {
                if existing.window.frame != screen.frame {
                    existing.window.setFrame(screen.frame, display: true)
                    displaysChanged = true
                }
                existing.screen = screen
                overlays[id] = existing
            } else {
                overlays[id] = createOverlay(for: screen)
                displaysChanged = true
            }
        }

        if displaysChanged {
            NSApp.activate(ignoringOtherApps: true)
            let pointer = NSEvent.mouseLocation
            let keyScreen = screens.first(where: { NSMouseInRect(pointer, $0.frame, false) })
                ?? NSScreen.main ?? screens[0]
            let keyID = displayIdentifier(keyScreen)
            for (id, display) in overlays where id != keyID {
                display.window.orderFrontRegardless()
            }
            overlays[keyID]?.window.makeKeyAndOrderFront(nil)
        }
        return !overlays.isEmpty
    }

    private func updateOverlayText() {
        for display in overlays.values {
            display.label.stringValue = labelText
            display.title.stringValue = titleText
        }
    }

    private func makeText(size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: "")
        field.font = NSFont.systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.alignment = .center
        field.maximumNumberOfLines = 4
        field.lineBreakMode = .byWordWrapping
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        return field
    }

    private func updateCountdown() {
        let elapsed = paused ? 0 : Date().timeIntervalSince(countdownUpdatedAt) * 1000
        let seconds = Int(ceil(max(0, remainingMilliseconds - elapsed) / 1000))
        let value = String(format: "%02d:%02d", seconds / 60, seconds % 60)
        for display in overlays.values { display.countdown.stringValue = value }
    }

    private func flashOnce() {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
        guard !overlays.isEmpty else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            for display in overlays.values { display.window.animator().alphaValue = 0.84 }
        } completionHandler: {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                for display in self.overlays.values { display.window.animator().alphaValue = 1 }
            }
        }
    }

    @objc private func tick() {
        if Date().timeIntervalSince(lastHeartbeat) > 8 { terminate(); return }
        updateCountdown()
        if !paused && !finished && remainingMilliseconds > 0 {
            let elapsed = Date().timeIntervalSince(countdownUpdatedAt) * 1000
            if elapsed >= remainingMilliseconds { finished = true; flashOnce() }
        }
    }

    @objc private func screenConfigurationChanged() {
        guard !overlays.isEmpty else { return }
        guard synchronizeDisplays() else {
            send(["type": "error", "message": "No display available"])
            terminate()
            return
        }
        updateOverlayText()
        updateCountdown()
    }

    @objc private func exitClicked() { dismiss() }

    private func dismiss() {
        send(["type": "dismissed"])
        terminate()
    }

    private func terminate() {
        heartbeatTimer?.invalidate()
        overlays.values.forEach {
            $0.window.orderOut(nil)
            $0.window.close()
        }
        overlays.removeAll()
        previousApp?.activate(options: [])
        NSApp.terminate(nil)
    }
}

if CommandLine.arguments.contains("--probe") {
    let displays = NSScreen.screens.map { screen in
        ["name": screen.localizedName, "frame": NSStringFromRect(screen.frame)]
    }
    let output = ["type": "probe", "screenCount": displays.count,
                  "screens": displays, "pointer": NSStringFromPoint(NSEvent.mouseLocation)] as [String: Any]
    if let data = try? JSONSerialization.data(withJSONObject: output),
       let line = String(data: data, encoding: .utf8) { print(line) }
} else {
    let app = NSApplication.shared
    let controller = OverlayController()
    app.delegate = controller
    app.run()
}
