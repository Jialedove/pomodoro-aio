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
    private var window: BlackoutWindow?
    private var label: NSTextField?
    private var title: NSTextField?
    private var countdown: NSTextField?
    private var currentScreen: NSScreen?
    private var previousApp: NSRunningApplication?
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
        let created = window == nil
        if created { createWindow() }
        guard window != nil else {
            send(["type": "error", "message": "No display available"])
            terminate()
            return
        }
        if let value = message["label"] as? String { label?.stringValue = value }
        if let value = message["title"] as? String { title?.stringValue = value }
        if let value = message["leftMs"] as? Double, value.isFinite {
            remainingMilliseconds = max(0, value)
            countdownUpdatedAt = Date()
        }
        paused = message["paused"] as? Bool ?? false
        updateCountdown()
        if remainingMilliseconds <= 0 && !finished {
            finished = true
            flashOnce()
        }
        if created { send(["type": "shown", "screen": currentScreen?.localizedName ?? "unknown"]) }
    }

    private func selectedScreen() -> NSScreen? {
        let pointer = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) })
            ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func createWindow() {
        guard let screen = selectedScreen() else { return }
        currentScreen = screen
        previousApp = NSWorkspace.shared.frontmostApplication
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

        label = makeText(size: 17, weight: .medium, color: NSColor.white.withAlphaComponent(0.72))
        title = makeText(size: 68, weight: .bold, color: .white)
        countdown = makeText(size: 52, weight: .medium, color: NSColor.white.withAlphaComponent(0.88))
        countdown?.font = NSFont.monospacedDigitSystemFont(ofSize: 52, weight: .medium)
        [label, title, countdown].compactMap { $0 }.forEach { stack.addArrangedSubview($0) }

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
        stack.setCustomSpacing(30, after: countdown!)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -32),
            title!.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, multiplier: 0.82),
            exitButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 224),
            exitButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        window = overlay
        NSApp.activate(ignoringOtherApps: true)
        overlay.makeKeyAndOrderFront(nil)
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
        countdown?.stringValue = String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    private func flashOnce() {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
        guard let window else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            window.animator().alphaValue = 0.84
        } completionHandler: {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                window.animator().alphaValue = 1
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
        guard let window else { return }
        guard let screen = currentScreen, NSScreen.screens.contains(screen) else {
            terminate()
            return
        }
        window.setFrame(screen.frame, display: true)
    }

    @objc private func exitClicked() { dismiss() }

    private func dismiss() {
        send(["type": "dismissed"])
        terminate()
    }

    private func terminate() {
        heartbeatTimer?.invalidate()
        window?.orderOut(nil)
        window?.close()
        window = nil
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
