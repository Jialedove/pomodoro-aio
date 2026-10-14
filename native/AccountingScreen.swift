import AppKit
import Foundation

// 时间归属选择屏：纯黑全屏覆盖所有显示器。选择界面显示在设置指定的屏幕上（默认带菜单栏的主显示器），
// 其他屏幕只显示一行提示。插件拥有全部状态；这里只负责展示并回传选择。stdin/stdout 均为换行分隔的 JSON。
//
// 插件 → 程序：{"type":"show", ...ScreenData}、{"type":"update", ...部分字段}、
//               {"type":"error","message":…}（重新启用按钮并显示错误）、{"type":"hide"}
// 程序 → 插件：{"type":"ready"}、{"type":"shown"}、
//               {"type":"choice","action":"work","moduleId","name","durationMin","workspaceCommandId","lightProgramId","blackout"}
//               {"type":"choice","action":"rest","moduleId","name","durationMin","lightProgramId","blackout"}
//               {"type":"choice","action":"declare","kind":"leisure|errand","reason","minutes"}
//               {"type":"choice","action":"again|resume|complete|next|snooze|close|emergency"}
//               {"type":"exit","reason":…}
// 命令行：--list-displays 打印所有显示器（UUID、名称、是否主显示器、尺寸）后退出。

struct ModuleItem {
    let id: String
    let name: String
    let durationMin: Double
    let workspaceCommandId: String
    let lightProgramId: String
    let blackout: Bool
}

struct Option {
    let id: String
    let title: String
}

struct ScreenData {
    var reason = "idle"
    var label = ""
    var title = "现在要做什么？"
    var closable = true
    var initialTab = "work"
    var display = "main"
    var workModules: [ModuleItem] = []
    var defaultWorkId: String?
    var candidates: [String] = []
    var restModules: [ModuleItem] = []
    var defaultRestId: String?
    var restPresets: [String] = []
    var workspaceCommands: [Option] = []
    var lightPrograms: [Option] = []
    var againText = ""
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
                return ModuleItem(id: id, name: name,
                                  durationMin: (item["durationMin"] as? NSNumber)?.doubleValue ?? 25,
                                  workspaceCommandId: item["workspaceCommandId"] as? String ?? "",
                                  lightProgramId: item["lightProgramId"] as? String ?? "",
                                  blackout: item["blackout"] as? Bool ?? false)
            }
        }
        func options(_ value: Any?) -> [Option]? {
            guard let list = value as? [[String: Any]] else { return nil }
            return list.compactMap { item in
                guard let id = item["id"] as? String, let title = item["title"] as? String else { return nil }
                return Option(id: id, title: title)
            }
        }
        func int(_ key: String) -> Int? { (message[key] as? NSNumber)?.intValue }
        if let value = message["reason"] as? String { reason = value }
        if let value = message["label"] as? String { label = value }
        if let value = message["title"] as? String { title = value }
        if let value = message["closable"] as? Bool { closable = value }
        if let value = message["initialTab"] as? String { initialTab = value }
        if let value = message["display"] as? String { display = value }
        if let value = modules(message["workModules"]) { workModules = value }
        if message.keys.contains("defaultWorkId") { defaultWorkId = message["defaultWorkId"] as? String }
        if let value = message["candidates"] as? [String] { candidates = value }
        if let value = modules(message["restModules"]) { restModules = value }
        if message.keys.contains("defaultRestId") { defaultRestId = message["defaultRestId"] as? String }
        if let value = message["restPresets"] as? [String] { restPresets = value }
        if let value = options(message["workspaceCommands"]) { workspaceCommands = value }
        if let value = options(message["lightPrograms"]) { lightPrograms = value }
        if let value = message["againText"] as? String { againText = value }
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
        setPlaceholder(placeholder, size: size)
        field.setAccessibilityLabel(placeholder)
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: width),
            heightAnchor.constraint(equalToConstant: size + 26),
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            field.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    func setPlaceholder(_ text: String, size: CGFloat = 20) {
        field.placeholderAttributedString = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size), .foregroundColor: Palette.faint
        ])
    }
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

func column(_ views: [NSView], spacing: CGFloat = 14, alignment: NSLayoutConstraint.Attribute = .centerX) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.spacing = spacing
    stack.alignment = alignment
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

/// 左侧固定宽度的字段名 + 控件。
func labeled(_ title: String, _ control: NSView) -> NSStackView {
    let label = makeLabel(title, size: 15, color: Palette.muted)
    label.alignment = .right
    label.translatesAutoresizingMaskIntoConstraints = false
    label.widthAnchor.constraint(equalToConstant: 44).isActive = true
    return row([label, control], spacing: 12)
}

func popup(_ items: [Option], selected: String, accessibility: String) -> NSPopUpButton {
    let button = NSPopUpButton(frame: .zero, pullsDown: false)
    button.controlSize = .large
    for item in items {
        button.addItem(withTitle: item.title)
        button.lastItem?.representedObject = item.id
    }
    selectOption(button, id: selected)
    button.setAccessibilityLabel(accessibility)
    return button
}

func selectOption(_ button: NSPopUpButton, id: String) {
    if let index = button.itemArray.firstIndex(where: { ($0.representedObject as? String) == id }) {
        button.selectItem(at: index)
    } else if !id.isEmpty {
        // 模块引用的选项已不在列表里：保留原值，避免开始时被悄悄改掉。
        button.addItem(withTitle: "当前设置（已不可用）")
        button.lastItem?.representedObject = id
        button.selectItem(at: button.numberOfItems - 1)
    } else {
        button.selectItem(at: 0)
    }
}

func checkbox(_ title: String, on: Bool) -> NSButton {
    let box = NSButton(checkboxWithTitle: title, target: nil, action: nil)
    box.attributedTitle = NSAttributedString(string: title, attributes: [
        .font: NSFont.systemFont(ofSize: 15), .foregroundColor: Palette.text
    ])
    box.state = on ? .on : .off
    return box
}

func formatMinutes(_ value: Double) -> String {
    value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
}

// MARK: - 选择面板

final class ChoicePanel: NSView, NSTextFieldDelegate, NSComboBoxDelegate {
    var data: ScreenData
    var send: ([String: Any]) -> Void = { _ in }

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
    // 工作
    private var workPopup: NSPopUpButton?
    private let workName = NSComboBox()
    private let workMinutes = InputBox(placeholder: "分钟", size: 18, width: 84)
    private var workLayout: NSPopUpButton?
    private var workLight: NSPopUpButton?
    private var workBlackout: NSButton?
    private var workMore = NSStackView()
    private var workMoreToggle: PillButton?
    // 休息
    private var restPopup: NSPopUpButton?
    private var presetButtons: [String: PillButton] = [:]
    private var selectedPreset: String?
    private let restCustom = InputBox(placeholder: "其他休息事项", size: 18, width: 300)
    private let restMinutes = InputBox(placeholder: "分钟", size: 18, width: 84)
    private var restLight: NSPopUpButton?
    private var restBlackout: NSButton?
    private var restMore = NSStackView()
    private var restMoreToggle: PillButton?
    // 小计时
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

        switch data.reason {
        case "paused":
            items.append(actions([("继续计时", .primary, { [weak self] in self?.choose(["action": "resume"]) }),
                                  ("完成本段", .secondary, { [weak self] in self?.choose(["action": "complete"]) })]))
        case "awaiting":
            items.append(actions([("开始下一段：\(data.currentName)", .primary, { [weak self] in self?.choose(["action": "next"]) })]))
        default:
            if !data.againText.isEmpty {
                let again = PillButton(data.againText, style: .secondary, size: 15, height: 38)
                again.onPress = { [weak self] in self?.choose(["action": "again"]) }
                actionButtons.append(again)
                items.append(again)
            }
            let tabs = row([("work", "工作", 1), ("rest", "休息", 2), ("declare", "小计时", 3)].map { key, name, number in
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
            // 固定宽度与最小高度，切换选项卡时下方内容不跳动。
            NSLayoutConstraint.activate([
                container.widthAnchor.constraint(equalToConstant: 680),
                container.heightAnchor.constraint(greaterThanOrEqualToConstant: 270)
            ])
            items.append(container)
        }

        items.append(status)
        if data.snoozesLeft > 0 {
            let snooze = PillButton("\(data.snoozeMin) 分钟后再提醒（今天剩 \(data.snoozesLeft) 次）", style: .link, size: 14)
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
        stack.setCustomSpacing(30, after: title)
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

    private func minuteRow(_ box: InputBox, chips: [Int]) -> NSStackView {
        box.field.alignment = .center
        box.field.delegate = self
        let buttons = chips.map { value -> NSView in
            let chip = PillButton("\(value)", style: .secondary, size: 15, minWidth: 52, height: 38)
            chip.onPress = { [weak self] in
                box.field.stringValue = String(value)
                self?.refreshDeclare()
            }
            return chip
        }
        return row([box, makeLabel("分钟", size: 15, color: Palette.muted)] + buttons, spacing: 10)
    }

    private func moreToggle(_ stack: NSStackView) -> PillButton {
        stack.isHidden = true
        let toggle = PillButton("更多选项 ▸", style: .link, size: 14)
        toggle.onPress = { [weak self, weak toggle] in
            stack.isHidden.toggle()
            toggle?.title = stack.isHidden ? "更多选项 ▸" : "更多选项 ▾"
            self?.needsLayout = true
        }
        return toggle
    }

    private func lightOptions() -> [Option] {
        [Option(id: "", title: "灯光：继承默认"), Option(id: "none", title: "灯光：不联动")]
            + data.lightPrograms.map { Option(id: $0.id, title: "灯光：\($0.title)") }
    }

    private func modulePopup(_ modules: [ModuleItem], selected: String?, noun: String) -> NSPopUpButton? {
        guard modules.count > 1 else { return nil }
        let options = modules.enumerated().map { index, module in Option(id: module.id, title: "第 \(index + 1) 个\(noun)：\(module.name)") }
        let button = popup(options, selected: selected ?? modules[0].id, accessibility: "选择\(noun)模块")
        button.target = self
        return button
    }

    private func buildWork() -> NSView {
        guard !data.workModules.isEmpty else {
            return column([makeLabel("序列里还没有工作模块，请先在番茄视图中添加。", size: 16, color: Palette.muted)])
        }
        var items: [NSView] = []
        if let popup = modulePopup(data.workModules, selected: data.defaultWorkId, noun: "工作") {
            popup.action = #selector(workModuleChanged)
            workPopup = popup
            items.append(popup)
        }
        workName.controlSize = .large
        workName.font = NSFont.systemFont(ofSize: 18)
        workName.completes = true
        workName.numberOfVisibleItems = 10
        workName.placeholderString = "现在要做的事（下拉选择今日待办，或直接输入）"
        workName.delegate = self
        workName.translatesAutoresizingMaskIntoConstraints = false
        workName.widthAnchor.constraint(equalToConstant: 500).isActive = true
        workName.setAccessibilityLabel("现在要做的事")
        refreshCandidates()
        items.append(labeled("事情", workName))
        items.append(labeled("时长", minuteRow(workMinutes, chips: [15, 25, 45, 60])))

        let layout = popup([Option(id: "", title: "布局：不切换")] + data.workspaceCommands.map { Option(id: $0.id, title: "布局：\($0.title)") },
                           selected: "", accessibility: "工作区布局")
        let light = popup(lightOptions(), selected: "", accessibility: "灯光方案")
        let blackout = checkbox("执行时黑屏", on: false)
        workLayout = layout
        workLight = light
        workBlackout = blackout
        workMore = row([layout, light, blackout], spacing: 14)
        let toggle = moreToggle(workMore)
        workMoreToggle = toggle
        items.append(toggle)
        items.append(workMore)
        items.append(primary("开始工作  ↵") { [weak self] in self?.submitWork() })
        fillWork()
        return column(items, spacing: 14)
    }

    private func currentWork() -> ModuleItem? {
        let id = (workPopup?.selectedItem?.representedObject as? String) ?? data.defaultWorkId
        return data.workModules.first(where: { $0.id == id }) ?? data.workModules.first
    }

    private func fillWork() {
        guard let module = currentWork() else { return }
        workName.stringValue = module.name == "工作" ? "" : module.name
        workMinutes.field.stringValue = formatMinutes(module.durationMin)
        if let workLayout { selectOption(workLayout, id: module.workspaceCommandId) }
        if let workLight { selectOption(workLight, id: module.lightProgramId) }
        workBlackout?.state = module.blackout ? .on : .off
    }

    @objc private func workModuleChanged() { fillWork() }

    private func refreshCandidates() {
        let typed = workName.stringValue
        workName.removeAllItems()
        workName.addItems(withObjectValues: data.candidates)
        workName.stringValue = typed
    }

    private func buildRest() -> NSView {
        guard !data.restModules.isEmpty else {
            return column([makeLabel("序列里还没有休息模块，请先在番茄视图中添加。", size: 16, color: Palette.muted)])
        }
        var items: [NSView] = []
        if let popup = modulePopup(data.restModules, selected: data.defaultRestId, noun: "休息") {
            popup.action = #selector(restModuleChanged)
            restPopup = popup
            items.append(popup)
        }
        if !data.restPresets.isEmpty {
            let buttons = data.restPresets.map { preset -> NSView in
                let button = PillButton(preset, style: .tab, size: 15, minWidth: 150, height: 42)
                button.onPress = { [weak self] in self?.choosePreset(preset) }
                presetButtons[preset] = button
                return button
            }
            items.append(grid(buttons, perRow: 3, spacing: 10))
        }
        restCustom.field.delegate = self
        items.append(labeled("其他", restCustom))
        items.append(labeled("时长", minuteRow(restMinutes, chips: [5, 10, 15, 20])))
        let light = popup(lightOptions(), selected: "", accessibility: "灯光方案")
        let blackout = checkbox("执行时黑屏", on: false)
        restLight = light
        restBlackout = blackout
        restMore = row([light, blackout], spacing: 14)
        let toggle = moreToggle(restMore)
        restMoreToggle = toggle
        items.append(toggle)
        items.append(restMore)
        items.append(primary("开始休息  ↵") { [weak self] in self?.submitRest() })
        fillRest()
        return column(items, spacing: 14)
    }

    private func currentRest() -> ModuleItem? {
        let id = (restPopup?.selectedItem?.representedObject as? String) ?? data.defaultRestId
        return data.restModules.first(where: { $0.id == id }) ?? data.restModules.first
    }

    private func fillRest() {
        guard let module = currentRest() else { return }
        if data.restPresets.contains(module.name) {
            choosePreset(module.name)
        } else {
            choosePreset(nil)
            restCustom.field.stringValue = module.name == "休息" ? "" : module.name
        }
        restMinutes.field.stringValue = formatMinutes(module.durationMin)
        if let restLight { selectOption(restLight, id: module.lightProgramId) }
        restBlackout?.state = module.blackout ? .on : .off
    }

    @objc private func restModuleChanged() { fillRest() }

    private func choosePreset(_ preset: String?) {
        selectedPreset = preset
        for (name, button) in presetButtons { button.isSelectedTab = name == preset }
        if preset != nil { restCustom.field.stringValue = "" }
        status.stringValue = ""
    }

    private func buildDeclare() -> NSView {
        let leisure = PillButton("消遣", style: .tab, size: 16, minWidth: 120, height: 40)
        let errand = PillButton("事务", style: .tab, size: 16, minWidth: 120, height: 40)
        leisure.onPress = { [weak self] in self?.declareKind = "leisure"; self?.refreshDeclare() }
        errand.onPress = { [weak self] in self?.declareKind = "errand"; self?.refreshDeclare() }
        leisureButton = leisure
        errandButton = errand
        let reason = InputBox(placeholder: "理由", size: 20, width: 560)
        reason.field.delegate = self
        reasonInput = reason
        let minutes = InputBox(placeholder: "分钟", size: 18, width: 84)
        minutes.field.stringValue = String(max(5, min(30, data.leisureLeftMin > 0 ? data.leisureLeftMin : 15)))
        minutesInput = minutes
        let minuteRowView = minuteRow(minutes, chips: [10, 15, 30, 60])
        refreshDeclare()
        let hint = makeLabel("小计时不算工作时间，到点后必须重新选择；记录写入当日日记。", size: 13, color: Palette.faint)
        return column([row([leisure, errand], spacing: 10), reason, minuteRowView, budgetHint, hint,
                       primary("开始小计时  ↵") { [weak self] in self?.submitDeclare() }], spacing: 14)
    }

    private func refreshDeclare() {
        leisureButton?.isSelectedTab = declareKind == "leisure"
        errandButton?.isSelectedTab = declareKind == "errand"
        reasonInput?.setPlaceholder(declareKind == "leisure" ? "理由，例如：刷 X、看视频" : "理由，例如：开会、处理快递")
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
        let target: NSView? = currentTab == "work" ? workName : currentTab == "declare" ? reasonInput?.field : nil
        window?.makeFirstResponder(target)
    }

    // 回车提交：通过代理捕获，避免组合框在下拉中点选时误触发提交。
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
        if control === workName, workName.cell?.isAccessibilityExpanded() == true { return false }
        submitFromKeyboard()
        return true
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        if field === restCustom.field, !field.stringValue.isEmpty { choosePreset(nil) }
        if field === minutesInput?.field { refreshDeclare() }
    }

    private func submitFromKeyboard() {
        // 刚出现时忽略回车，避免把正在输入的内容当作选择提交。
        guard Date().timeIntervalSince(shownAt) >= 0.8 else { return }
        switch currentTab {
        case "work": submitWork()
        case "rest": submitRest()
        default: submitDeclare()
        }
    }

    private func minutes(_ box: InputBox) -> Double? {
        guard let value = Double(box.field.stringValue.trimmingCharacters(in: .whitespaces)), value >= 1, value <= 480 else { return nil }
        return value
    }

    private func submitWork() {
        guard let module = currentWork() else { return }
        let name = workName.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { show(error: "先写下现在要做的事"); focusCurrent(); return }
        guard let duration = minutes(workMinutes) else { show(error: "时长须为 1–480 分钟"); return }
        choose(["action": "work", "moduleId": module.id, "name": name, "durationMin": duration,
                "workspaceCommandId": workLayout?.selectedItem?.representedObject as? String ?? "",
                "lightProgramId": workLight?.selectedItem?.representedObject as? String ?? "",
                "blackout": workBlackout?.state == .on])
    }

    private func submitRest() {
        guard let module = currentRest() else { return }
        let custom = restCustom.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name = selectedPreset ?? (custom.isEmpty ? nil : custom) else {
            show(error: "先选一个休息事项，或写下其他休息事项"); return
        }
        guard let duration = minutes(restMinutes) else { show(error: "时长须为 1–480 分钟"); return }
        choose(["action": "rest", "moduleId": module.id, "name": name, "durationMin": duration,
                "lightProgramId": restLight?.selectedItem?.representedObject as? String ?? "",
                "blackout": restBlackout?.state == .on])
    }

    private func submitDeclare() {
        let reason = reasonInput?.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !reason.isEmpty else { show(error: "请写下理由"); focusCurrent(); return }
        guard let value = minutesInput.flatMap(minutes) else { show(error: "时长须为 1–480 分钟"); return }
        choose(["action": "declare", "kind": declareKind, "reason": reason, "minutes": value])
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

func displayNumber(_ screen: NSScreen) -> CGDirectDisplayID? {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
}

/// 显示器 UUID：比显示器编号稳定，拔插或重启后仍能认出同一块屏幕。
func displayUUID(_ screen: NSScreen) -> String? {
    guard let number = displayNumber(screen),
          let uuid = CGDisplayCreateUUIDFromDisplayID(number)?.takeRetainedValue() else { return nil }
    return CFUUIDCreateString(nil, uuid) as String
}

final class ScreenController: NSObject, NSApplicationDelegate {
    private var windows: [String: ScreenWindow] = [:]
    private var panel: ChoicePanel?
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
        panel.send = { [weak self] message in self?.send(message) }
        self.panel = panel
        synchronizeWindows(fadeIn: true)
        send(["type": "shown", "screenCount": windows.count])
    }

    private func screenID(_ screen: NSScreen) -> String {
        if let number = displayNumber(screen) { return "display-\(number)" }
        return "\(screen.localizedName)-\(NSStringFromRect(screen.frame))"
    }

    /// 选择界面所在的屏幕：按设置找；指定的显示器没连接时退回带菜单栏的主显示器。
    private func panelScreen(_ screens: [NSScreen]) -> NSScreen {
        let preference = panel?.data.display ?? "main"
        if preference == "pointer" {
            let pointer = NSEvent.mouseLocation
            return screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? screens[0]
        }
        if preference != "main", let match = screens.first(where: { displayUUID($0) == preference }) {
            return match
        }
        return screens[0]
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

    private var panelScreenID: String?

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
        let target = panelScreen(screens)
        let targetID = screenID(target)
        let moved = targetID != panelScreenID
        panelScreenID = targetID
        for screen in screens {
            let id = screenID(screen)
            let window = windows[id] ?? makeWindow(for: screen)
            let isNew = windows[id] == nil
            windows[id] = window
            if window.frame != screen.frame { window.setFrame(screen.frame, display: true) }
            guard let content = window.contentView else { continue }
            if isNew || moved {
                content.subviews.forEach { $0.removeFromSuperview() }
                let child: NSView
                if id == targetID {
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
            }
            if fadeIn && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { window.alphaValue = 0 }
            window.orderFrontRegardless()
        }
        NSApp.activate(ignoringOtherApps: true)
        if let window = windows[targetID] {
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

if CommandLine.arguments.contains("--list-displays") {
    let list = NSScreen.screens.enumerated().map { index, screen -> [String: Any] in
        ["id": displayUUID(screen) ?? "", "name": screen.localizedName, "main": index == 0,
         "width": Int(screen.frame.width), "height": Int(screen.frame.height)]
    }
    if let data = try? JSONSerialization.data(withJSONObject: list), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
    exit(0)
}

let app = NSApplication.shared
let controller = ScreenController()
app.delegate = controller
app.run()
