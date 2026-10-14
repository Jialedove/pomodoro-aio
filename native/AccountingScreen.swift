import AppKit
import Foundation

// 时间归属选择屏：黑色全屏覆盖所有显示器。指针所在的屏幕显示选择界面，其他屏幕只显示一行提示。
// 插件拥有全部状态；这里只负责展示并回传选择。stdin/stdout 均为换行分隔的 JSON。
//
// 插件 → 程序：{"type":"show", ...ScreenData}、{"type":"update", ...部分字段}、
//               {"type":"error","message":…}（重新启用按钮并显示错误）、{"type":"hide"}
// 程序 → 插件：{"type":"ready"}、{"type":"shown"}、
//               {"type":"choice","action":"work","moduleId":…,"name":…}
//               {"type":"choice","action":"rest","moduleId":…}
//               {"type":"choice","action":"declare","kind":"leisure|errand","reason":…,"minutes":…}
//               {"type":"choice","action":"resume|complete|next|snooze|close|emergency"}
//               {"type":"exit","reason":…}

struct ModuleItem {
    let id: String
    let name: String
}

struct ScreenData {
    var reason = "idle"
    var label = ""
    var title = "现在要做什么？"
    var closable = true
    var initialTab = "work"
    var workModules: [ModuleItem] = []
    var defaultWorkId: String?
    var taskName = ""
    var candidates: [String] = []
    var restModules: [ModuleItem] = []
    var leisureLeftMin = 0
    var strictBudget = false
    var snoozesLeft = 0
    var snoozeMin = 10
    var currentName = ""

    mutating func apply(_ message: [String: Any]) {
        func modules(_ value: Any?) -> [ModuleItem]? {
            guard let list = value as? [[String: Any]] else { return nil }
            return list.compactMap { item in
                guard let id = item["id"] as? String, let name = item["name"] as? String else { return nil }
                return ModuleItem(id: id, name: name)
            }
        }
        func int(_ key: String) -> Int? { (message[key] as? NSNumber)?.intValue }
        if let value = message["reason"] as? String { reason = value }
        if let value = message["label"] as? String { label = value }
        if let value = message["title"] as? String { title = value }
        if let value = message["closable"] as? Bool { closable = value }
        if let value = message["initialTab"] as? String { initialTab = value }
        if let value = modules(message["workModules"]) { workModules = value }
        if message.keys.contains("defaultWorkId") { defaultWorkId = message["defaultWorkId"] as? String }
        if let value = message["taskName"] as? String { taskName = value }
        if let value = message["candidates"] as? [String] { candidates = value }
        if let value = modules(message["restModules"]) { restModules = value }
        if let value = int("leisureLeftMin") { leisureLeftMin = value }
        if let value = message["strictBudget"] as? Bool { strictBudget = value }
        if let value = int("snoozesLeft") { snoozesLeft = value }
        if let value = int("snoozeMin") { snoozeMin = value }
        if let value = message["currentName"] as? String { currentName = value }
    }
}

// MARK: - 视觉组件

enum Palette {
    static let text = NSColor.white
    static let muted = NSColor.white.withAlphaComponent(0.62)
    static let faint = NSColor.white.withAlphaComponent(0.38)
    static let fill = NSColor.white.withAlphaComponent(0.08)
    static let fillHover = NSColor.white.withAlphaComponent(0.14)
    static let stroke = NSColor.white.withAlphaComponent(0.22)
    static let warning = NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.36, alpha: 1)
}

func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = Palette.text) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = NSFont.systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.alignment = .center
    field.lineBreakMode = .byWordWrapping
    field.maximumNumberOfLines = 3
    field.cell?.wraps = true
    return field
}

final class PillButton: NSButton {
    enum Style { case primary, secondary, tab, link }
    var style: Style { didSet { refresh() } }
    var isSelectedTab = false { didSet { refresh() } }
    var onPress: (() -> Void)?
    private var hovering = false
    private let fontSize: CGFloat

    init(_ title: String, style: Style, size: CGFloat = 16, minWidth: CGFloat = 0, height: CGFloat = 44) {
        self.style = style
        self.fontSize = size
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = style == .link ? 6 : height / 2.6
        focusRingType = .none
        target = self
        action = #selector(pressed)
        translatesAutoresizingMaskIntoConstraints = false
        if style != .link { heightAnchor.constraint(equalToConstant: height).isActive = true }
        if minWidth > 0 { widthAnchor.constraint(greaterThanOrEqualToConstant: minWidth).isActive = true }
        setAccessibilityLabel(title)
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var title: String { didSet { refresh() } }
    override var isEnabled: Bool { didSet { refresh() } }
    override var intrinsicContentSize: NSSize {
        let base = super.intrinsicContentSize
        return NSSize(width: base.width + (style == .link ? 8 : 40), height: base.height)
    }

    @objc private func pressed() { onPress?() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; refresh() }
    override func mouseExited(with event: NSEvent) { hovering = false; refresh() }

    private func refresh() {
        let selected = style == .primary || (style == .tab && isSelectedTab)
        let foreground: NSColor = !isEnabled ? Palette.faint : selected ? .black : style == .link ? (hovering ? Palette.text : Palette.muted) : Palette.text
        let weight: NSFont.Weight = selected ? .semibold : .medium
        attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
            .foregroundColor: foreground
        ])
        let background: NSColor
        switch style {
        case .link: background = .clear
        case .primary: background = isEnabled ? (hovering ? NSColor.white.withAlphaComponent(0.88) : .white) : Palette.fill
        case .tab: background = isSelectedTab ? .white : (hovering ? Palette.fillHover : Palette.fill)
        case .secondary: background = hovering ? Palette.fillHover : Palette.fill
        }
        layer?.backgroundColor = background.cgColor
        layer?.borderWidth = style == .secondary || (style == .tab && !isSelectedTab) ? 1 : 0
        layer?.borderColor = Palette.stroke.cgColor
    }
}

/// 圆角深色输入框：外层容器负责底色与内边距，内层是无边框的 NSTextField。
final class InputBox: NSView {
    let field = NSTextField()

    init(placeholder: String, size: CGFloat = 20, width: CGFloat) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.backgroundColor = Palette.fill.cgColor
        layer?.borderWidth = 1
        layer?.borderColor = Palette.stroke.cgColor
        translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: size)
        field.textColor = Palette.text
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
            .font: NSFont.systemFont(ofSize: size), .foregroundColor: Palette.faint
        ])
        field.setAccessibilityLabel(placeholder)
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: width),
            heightAnchor.constraint(equalToConstant: size + 28),
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            field.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError("not supported") }
}

/// 长按 Esc 的进度条。
final class HoldBar: NSView {
    var progress: CGFloat = 0 { didSet { needsDisplay = true } }

    override var intrinsicContentSize: NSSize { NSSize(width: 260, height: 4) }

    override func draw(_ dirtyRect: NSRect) {
        let track = NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2)
        Palette.fill.setFill()
        track.fill()
        guard progress > 0 else { return }
        var fill = bounds
        fill.size.width = bounds.width * min(1, progress)
        NSColor.white.setFill()
        NSBezierPath(roundedRect: fill, xRadius: 2, yRadius: 2).fill()
    }
}

func row(_ views: [NSView], spacing: CGFloat = 12) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal
    stack.spacing = spacing
    stack.alignment = .centerY
    return stack
}

func column(_ views: [NSView], spacing: CGFloat = 14) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.spacing = spacing
    stack.alignment = .centerX
    return stack
}

/// 按每行 perRow 个排成多行。
func grid(_ views: [NSView], perRow: Int, spacing: CGFloat = 10) -> NSStackView {
    var rows: [NSView] = []
    var index = 0
    while index < views.count {
        rows.append(row(Array(views[index..<min(index + perRow, views.count)]), spacing: spacing))
        index += perRow
    }
    return column(rows, spacing: spacing)
}

// MARK: - 选择面板

final class ChoicePanel: NSView {
    var data: ScreenData
    var send: ([String: Any]) -> Void = { _ in }
    var onEmergencyProgress: ((CGFloat) -> Void)?

    private let shownAt = Date()
    private var busy = false
    private var currentTab = "work"
    private var declareKind = "leisure"
    private var tabButtons: [String: PillButton] = [:]
    private var panels: [String: NSView] = [:]
    private var actionButtons: [PillButton] = []
    private let labelField = makeLabel("", size: 16, color: Palette.muted)
    private let status = makeLabel("", size: 14, color: Palette.warning)
    private let holdHint = makeLabel("长按 esc 3 秒紧急退出", size: 13, color: Palette.faint)
    private let holdBar = HoldBar()
    private var workInput: InputBox?
    private var workPopup: NSPopUpButton?
    private var candidateArea = NSStackView()
    private var reasonInput: InputBox?
    private var minutesInput: InputBox?
    private var leisureButton: PillButton?
    private var errandButton: PillButton?
    private let budgetHint = makeLabel("", size: 14, color: Palette.muted)

    init(data: ScreenData) {
        self.data = data
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        build()
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    // MARK: 构建

    private func build() {
        let title = makeLabel(data.title, size: 44, weight: .bold)
        labelField.stringValue = data.label
        var items: [NSView] = [labelField, title]
        var spacingAfterTitle: CGFloat = 36

        switch data.reason {
        case "paused":
            items.append(actions([("继续计时", .primary, { [weak self] in self?.choose(["action": "resume"]) }),
                                  ("完成本段", .secondary, { [weak self] in self?.choose(["action": "complete"]) })]))
        case "awaiting":
            items.append(actions([("开始下一段：\(data.currentName)", .primary, { [weak self] in self?.choose(["action": "next"]) })]))
        default:
            spacingAfterTitle = 32
            let tabs = row(tabSpecs().map { key, name, number in
                let button = PillButton("\(number)  \(name)", style: .tab, size: 18, minWidth: 150, height: 56)
                button.onPress = { [weak self] in self?.select(tab: key) }
                tabButtons[key] = button
                return button
            }, spacing: 14)
            items.append(tabs)
            let container = NSView()
            container.translatesAutoresizingMaskIntoConstraints = false
            panels = ["work": buildWork(), "rest": buildRest(), "declare": buildDeclare()]
            for panel in panels.values {
                panel.translatesAutoresizingMaskIntoConstraints = false
                container.addSubview(panel)
                NSLayoutConstraint.activate([
                    panel.topAnchor.constraint(equalTo: container.topAnchor),
                    panel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
                    container.bottomAnchor.constraint(greaterThanOrEqualTo: panel.bottomAnchor)
                ])
            }
            // 固定最小高度，切换选项卡时下方内容不跳动。
            NSLayoutConstraint.activate([
                container.widthAnchor.constraint(equalToConstant: 640),
                container.heightAnchor.constraint(greaterThanOrEqualToConstant: 250)
            ])
            items.append(container)
        }

        items.append(status)
        let snooze = data.snoozesLeft > 0
            ? PillButton("\(data.snoozeMin) 分钟后再提醒（今天剩 \(data.snoozesLeft) 次）", style: .link, size: 14)
            : nil
        if let snooze {
            snooze.onPress = { [weak self] in self?.choose(["action": "snooze"]) }
            actionButtons.append(snooze)
            items.append(snooze)
        } else {
            items.append(makeLabel("今天的稍后提醒已用完", size: 14, color: Palette.faint))
        }
        if !data.closable {
            items.append(column([holdHint, holdBar], spacing: 8))
        }

        let stack = column(items, spacing: 14)
        stack.setCustomSpacing(10, after: labelField)
        stack.setCustomSpacing(spacingAfterTitle, after: title)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            title.widthAnchor.constraint(lessThanOrEqualToConstant: 900)
        ])
        if data.reason == "idle" {
            let initial = panels[data.initialTab] != nil ? data.initialTab : "work"
            select(tab: initial, animated: false)
        }
    }

    private func tabSpecs() -> [(String, String, Int)] {
        [("work", "工作", 1), ("rest", "休息", 2), ("declare", "不计时", 3)]
    }

    private func actions(_ specs: [(String, PillButton.Style, () -> Void)]) -> NSView {
        row(specs.map { title, style, handler in
            let button = PillButton(title, style: style, size: 18, minWidth: 180, height: 56)
            button.onPress = handler
            actionButtons.append(button)
            return button
        }, spacing: 16)
    }

    private func primary(_ title: String, _ handler: @escaping () -> Void) -> PillButton {
        let button = PillButton(title, style: .primary, size: 17, minWidth: 200, height: 50)
        button.onPress = handler
        actionButtons.append(button)
        return button
    }

    private func buildWork() -> NSView {
        guard !data.workModules.isEmpty else {
            return column([makeLabel("序列里还没有工作模块，请先在番茄视图中添加。", size: 16, color: Palette.muted)])
        }
        var items: [NSView] = []
        if data.workModules.count > 1 {
            let popup = NSPopUpButton()
            for (index, module) in data.workModules.enumerated() {
                popup.addItem(withTitle: "第 \(index + 1) 个工作：\(module.name)")
                popup.lastItem?.representedObject = module.id
            }
            if let id = data.defaultWorkId, let index = data.workModules.firstIndex(where: { $0.id == id }) {
                popup.selectItem(at: index)
            }
            popup.target = self
            popup.action = #selector(workModuleChanged)
            popup.setAccessibilityLabel("从哪个工作模块开始")
            workPopup = popup
            items.append(popup)
        }
        let input = InputBox(placeholder: "现在要做的事", size: 22, width: 560)
        input.field.stringValue = data.taskName
        input.field.target = self
        input.field.action = #selector(submitFromField)
        workInput = input
        items.append(input)
        candidateArea = column([], spacing: 10)
        items.append(candidateArea)
        refreshCandidates()
        items.append(primary("开始工作  ↵") { [weak self] in self?.submitWork() })
        return column(items, spacing: 16)
    }

    private func refreshCandidates() {
        candidateArea.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let names = Array(data.candidates.prefix(6))
        guard !names.isEmpty else { return }
        let chips = names.map { name -> NSView in
            let chip = PillButton(name, style: .secondary, size: 14, height: 34)
            chip.onPress = { [weak self] in
                self?.workInput?.field.stringValue = name
                self?.window?.makeFirstResponder(self?.workInput?.field)
            }
            return chip
        }
        candidateArea.addArrangedSubview(makeLabel("今日待办", size: 13, color: Palette.faint))
        candidateArea.addArrangedSubview(grid(chips, perRow: 3))
    }

    private func buildRest() -> NSView {
        guard !data.restModules.isEmpty else {
            return column([makeLabel("序列里还没有休息模块，请先在番茄视图中添加。", size: 16, color: Palette.muted)])
        }
        let buttons = data.restModules.map { module -> NSView in
            let button = PillButton(module.name, style: .secondary, size: 17, minWidth: 180, height: 52)
            button.onPress = { [weak self] in self?.choose(["action": "rest", "moduleId": module.id]) }
            actionButtons.append(button)
            return button
        }
        return column([makeLabel("点一下就开始", size: 14, color: Palette.faint), grid(buttons, perRow: 3, spacing: 12)], spacing: 16)
    }

    private func buildDeclare() -> NSView {
        let leisure = PillButton("消遣", style: .tab, size: 16, minWidth: 120, height: 40)
        let errand = PillButton("事务", style: .tab, size: 16, minWidth: 120, height: 40)
        leisure.onPress = { [weak self] in self?.declareKind = "leisure"; self?.refreshDeclare() }
        errand.onPress = { [weak self] in self?.declareKind = "errand"; self?.refreshDeclare() }
        leisureButton = leisure
        errandButton = errand
        let reason = InputBox(placeholder: "理由", size: 20, width: 560)
        reason.field.target = self
        reason.field.action = #selector(submitFromField)
        reasonInput = reason
        let minutes = InputBox(placeholder: "分钟", size: 20, width: 110)
        minutes.field.alignment = .center
        minutes.field.stringValue = String(max(5, min(30, data.leisureLeftMin > 0 ? data.leisureLeftMin : 15)))
        minutes.field.target = self
        minutes.field.action = #selector(submitFromField)
        minutesInput = minutes
        NotificationCenter.default.addObserver(self, selector: #selector(minutesChanged), name: NSControl.textDidChangeNotification, object: minutes.field)
        let chips = [10, 15, 30, 60].map { value -> NSView in
            let chip = PillButton("\(value)", style: .secondary, size: 15, minWidth: 56, height: 40)
            chip.onPress = { [weak self] in
                self?.minutesInput?.field.stringValue = String(value)
                self?.refreshDeclare()
            }
            return chip
        }
        let minuteRow = row([minutes, makeLabel("分钟", size: 16, color: Palette.muted)] + chips, spacing: 10)
        refreshDeclare()
        return column([row([leisure, errand], spacing: 10), reason, minuteRow, budgetHint,
                       primary("开始不计时  ↵") { [weak self] in self?.submitDeclare() }], spacing: 14)
    }

    @objc private func minutesChanged() { refreshDeclare() }

    private func refreshDeclare() {
        leisureButton?.isSelectedTab = declareKind == "leisure"
        errandButton?.isSelectedTab = declareKind == "errand"
        reasonInput?.field.placeholderAttributedString = NSAttributedString(
            string: declareKind == "leisure" ? "理由，例如：刷 X、看视频" : "理由，例如：开会、处理快递",
            attributes: [.font: NSFont.systemFont(ofSize: 20), .foregroundColor: Palette.faint])
        let left = data.leisureLeftMin
        let planned = Int(minutesInput?.field.stringValue ?? "") ?? 0
        let over = declareKind == "leisure" && planned > left
        budgetHint.textColor = over ? Palette.warning : Palette.muted
        budgetHint.stringValue = declareKind == "errand" ? "事务不占消遣额度，同样记入日记。"
            : data.strictBudget && left < 1 ? "今日消遣额度已用完（强制模式）。"
            : over ? (data.strictBudget ? "今日消遣剩余 \(left) 分钟，强制模式下会截为 \(left) 分钟。"
                      : "今日消遣剩余 \(left) 分钟，本次会超出 \(planned - left) 分钟并记入日记。")
            : "今日消遣剩余 \(left) 分钟。"
    }

    // MARK: 交互

    func select(tab: String, animated: Bool = true) {
        guard data.reason == "idle", panels[tab] != nil, !busy else { return }
        currentTab = tab
        for (key, button) in tabButtons { button.isSelectedTab = key == tab }
        for (key, panel) in panels {
            let visible = key == tab
            if animated && visible {
                panel.alphaValue = 0
                panel.isHidden = false
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.18
                    panel.animator().alphaValue = 1
                }
            } else {
                panel.isHidden = !visible
                panel.alphaValue = 1
            }
        }
        status.stringValue = ""
        focusCurrent()
    }

    func focusCurrent() {
        let target: NSView? = currentTab == "work" ? workInput?.field : currentTab == "declare" ? reasonInput?.field : nil
        window?.makeFirstResponder(target)
    }

    @objc private func workModuleChanged() {
        guard let id = workPopup?.selectedItem?.representedObject as? String,
              let module = data.workModules.first(where: { $0.id == id }) else { return }
        workInput?.field.stringValue = module.name == "工作" ? "" : module.name
    }

    @objc private func submitFromField() {
        // 刚出现时忽略回车，避免把正在输入的内容当作选择提交。
        guard Date().timeIntervalSince(shownAt) >= 0.8 else { return }
        if currentTab == "work" { submitWork() } else if currentTab == "declare" { submitDeclare() }
    }

    private func submitWork() {
        let name = workInput?.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !name.isEmpty else { show(error: "先写下现在要做的事"); focusCurrent(); return }
        let moduleId = (workPopup?.selectedItem?.representedObject as? String) ?? data.defaultWorkId ?? data.workModules.first?.id ?? ""
        choose(["action": "work", "moduleId": moduleId, "name": name])
    }

    private func submitDeclare() {
        let reason = reasonInput?.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !reason.isEmpty else { show(error: "请写下理由"); focusCurrent(); return }
        guard let minutes = Double(minutesInput?.field.stringValue ?? ""), minutes > 0 else {
            show(error: "请填写时长（分钟）"); return
        }
        choose(["action": "declare", "kind": declareKind, "reason": reason, "minutes": minutes])
    }

    func choose(_ payload: [String: Any]) {
        guard !busy else { return }
        if Date().timeIntervalSince(shownAt) < 0.3 { return }
        busy = true
        actionButtons.forEach { $0.isEnabled = false }
        status.textColor = Palette.muted
        status.stringValue = "正在处理…"
        var message = payload
        message["type"] = "choice"
        send(message)
    }

    func show(error: String) {
        busy = false
        actionButtons.forEach { $0.isEnabled = true }
        status.textColor = Palette.warning
        status.stringValue = error
    }

    func update(_ message: [String: Any]) {
        data.apply(message)
        labelField.stringValue = data.label
        if message["candidates"] != nil { refreshCandidates() }
    }

    func setHoldProgress(_ value: CGFloat) {
        holdBar.progress = value
        holdHint.textColor = value > 0 ? Palette.text : Palette.faint
    }
}

// MARK: - 窗口与控制器

final class ScreenWindow: NSWindow {
    var onEscape: ((_ down: Bool, _ repeated: Bool) -> Void)?
    var onDigit: ((Int) -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown || event.type == .keyUp {
            let editor = firstResponder as? NSTextView
            // 输入法组字时 Esc 用于取消组字，交给文本框处理。
            if event.keyCode == 53, editor?.hasMarkedText() != true {
                onEscape?(event.type == .keyDown, event.isARepeat)
                return
            }
            if event.type == .keyDown, editor == nil,
               event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty,
               let chars = event.charactersIgnoringModifiers, let digit = Int(chars), (1...3).contains(digit) {
                onDigit?(digit)
                return
            }
        }
        super.sendEvent(event)
    }
}

final class ScreenController: NSObject, NSApplicationDelegate {
    private var windows: [String: ScreenWindow] = [:]
    private var panel: ChoicePanel?
    private var panelScreenID: String?
    private var previousApp: NSRunningApplication?
    private var terminating = false
    private let parentPID = getppid()
    private var watchdog: Timer?
    private var holdStartedAt: Date?
    private var holdTimer: Timer?
    private var releaseTimer: Timer?
    private var holdProgress: CGFloat = 0
    private static let holdSeconds: TimeInterval = 3

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            // 被 launchd 收养说明插件已经退出。
            guard let self, getppid() != self.parentPID else { return }
            self.terminate(reason: "parent-exited", restore: true)
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                DispatchQueue.main.async { self?.handle(line: line) }
            }
            DispatchQueue.main.async { self?.terminate(reason: "stdin-closed", restore: true) }
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
        switch command {
        case "show":
            if let panel { panel.update(message); return }
            var screenData = ScreenData()
            screenData.apply(message)
            show(screenData)
        case "update":
            panel?.update(message)
        case "error":
            panel?.show(error: message["message"] as? String ?? "操作失败，请重试")
        case "hide":
            terminate(reason: "hide", restore: true)
        default:
            break
        }
    }

    private func show(_ data: ScreenData) {
        previousApp = NSWorkspace.shared.frontmostApplication
        let panel = ChoicePanel(data: data)
        panel.send = { [weak self] message in
            self?.send(message)
        }
        self.panel = panel
        synchronizeWindows(fadeIn: true)
        send(["type": "shown", "screenCount": windows.count])
    }

    private func screenID(_ screen: NSScreen) -> String {
        if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            return "display-\(number.uint32Value)"
        }
        return "\(screen.localizedName)-\(NSStringFromRect(screen.frame))"
    }

    private func makeWindow(for screen: NSScreen) -> ScreenWindow {
        let window = ScreenWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.appearance = NSAppearance(named: .darkAqua)
        // 纯黑不透明：选择屏要完全挡住底下的内容。
        window.isOpaque = true
        window.backgroundColor = .black
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.contentView = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        window.onEscape = { [weak self] down, repeated in self?.escape(down: down, repeated: repeated) }
        window.onDigit = { [weak self] digit in
            self?.panel?.select(tab: ["work", "rest", "declare"][digit - 1])
        }
        return window
    }

    private func synchronizeWindows(fadeIn: Bool = false) {
        guard let panel else { return }
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return }
        let ids = Set(screens.map(screenID))
        for id in windows.keys where !ids.contains(id) {
            windows[id]?.orderOut(nil)
            windows[id]?.close()
            windows.removeValue(forKey: id)
        }
        // 选择界面放在指针所在的屏幕；原屏幕消失时换到主屏幕。
        if panelScreenID == nil || !ids.contains(panelScreenID!) {
            let pointer = NSEvent.mouseLocation
            let target = screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main ?? screens[0]
            panelScreenID = screenID(target)
        }
        for screen in screens {
            let id = screenID(screen)
            let window = windows[id] ?? makeWindow(for: screen)
            windows[id] = window
            if window.frame != screen.frame { window.setFrame(screen.frame, display: true) }
            guard let content = window.contentView else { continue }
            content.subviews.forEach { $0.removeFromSuperview() }
            let child: NSView
            if id == panelScreenID {
                child = panel
            } else {
                child = makeLabel("在主屏幕上选择现在要做的事", size: 18, color: Palette.faint)
                child.translatesAutoresizingMaskIntoConstraints = false
            }
            content.addSubview(child)
            NSLayoutConstraint.activate([
                child.centerXAnchor.constraint(equalTo: content.centerXAnchor),
                child.centerYAnchor.constraint(equalTo: content.centerYAnchor),
                child.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 32)
            ])
            if fadeIn && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { window.alphaValue = 0 }
            window.orderFrontRegardless()
        }
        NSApp.activate(ignoringOtherApps: true)
        if let id = panelScreenID, let window = windows[id] {
            window.makeKeyAndOrderFront(nil)
            DispatchQueue.main.async { panel.focusCurrent() }
        }
        if fadeIn {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.22
                windows.values.forEach { $0.animator().alphaValue = 1 }
            }
        }
    }

    @objc private func screensChanged() {
        synchronizeWindows()
    }

    // MARK: Esc

    private func escape(down: Bool, repeated: Bool) {
        guard let panel else { return }
        if panel.data.closable {
            if down && !repeated {
                send(["type": "choice", "action": "close"])
                terminate(reason: "closed", restore: true)
            }
            return
        }
        if down {
            guard holdStartedAt == nil else { return }
            releaseTimer?.invalidate()
            // 松手回落途中再次按下时，从当前进度继续。
            holdStartedAt = Date().addingTimeInterval(-Double(holdProgress) * Self.holdSeconds)
            holdTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.holdTick() }
        } else {
            cancelHold()
        }
    }

    private func holdTick() {
        guard let started = holdStartedAt, let panel else { return }
        holdProgress = min(1, CGFloat(Date().timeIntervalSince(started) / Self.holdSeconds))
        panel.setHoldProgress(holdProgress)
        if holdProgress >= 1 {
            cancelHold()
            send(["type": "choice", "action": "emergency"])
            terminate(reason: "emergency", restore: true)
        }
    }

    private func cancelHold() {
        holdTimer?.invalidate()
        holdTimer = nil
        holdStartedAt = nil
        let from = holdProgress
        guard from > 0, let panel else { return }
        // 松手后进度条在 0.2 秒内回落，而不是瞬间消失。
        let start = Date()
        releaseTimer?.invalidate()
        releaseTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self, self.holdStartedAt == nil else { timer.invalidate(); return }
            let t = min(1, CGFloat(Date().timeIntervalSince(start) / 0.2))
            self.holdProgress = from * (1 - t)
            panel.setHoldProgress(self.holdProgress)
            if t >= 1 { timer.invalidate() }
        }
    }

    private func terminate(reason: String, restore: Bool) {
        if terminating { return }
        terminating = true
        send(["type": "exit", "reason": reason])
        watchdog?.invalidate()
        holdTimer?.invalidate()
        releaseTimer?.invalidate()
        windows.values.forEach {
            $0.orderOut(nil)
            $0.close()
        }
        windows.removeAll()
        if restore { previousApp?.activate(options: []) }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let controller = ScreenController()
app.delegate = controller
app.run()
