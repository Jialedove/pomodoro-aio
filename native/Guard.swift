import AppKit
import CoreGraphics
import Foundation

// pomodoro-guard：登录后由 LaunchAgent 常驻。人在电脑前、且 Obsidian 已连续 grace 秒
// 没有运行时自动打开 Obsidian，让 Pomodoro AIO 的时间归属提醒始终在场。
// 只负责“让插件在场”；计时、归属和提醒全部由插件负责。
// 参数：--interval 秒（默认 30）--idle 秒（默认 120）--grace 秒（默认 60）
//       --bundle 标识（默认 md.obsidian）--status 打印当前状态后退出 --dry-run 只记录不打开

struct GuardOptions {
    var interval: TimeInterval = 30
    var idleThreshold: TimeInterval = 120
    var grace: TimeInterval = 60
    var bundleID = "md.obsidian"
    var statusOnly = false
    var dryRun = false

    init(arguments: [String]) {
        var index = 1
        func number(_ fallback: TimeInterval) -> TimeInterval {
            index += 1
            guard index < arguments.count, let value = Double(arguments[index]), value > 0 else { return fallback }
            return value
        }
        while index < arguments.count {
            switch arguments[index] {
            case "--interval": interval = number(interval)
            case "--idle": idleThreshold = number(idleThreshold)
            case "--grace": grace = number(grace)
            case "--bundle":
                index += 1
                if index < arguments.count { bundleID = arguments[index] }
            case "--status": statusOnly = true
            case "--dry-run": dryRun = true
            default: break
            }
            index += 1
        }
    }
}

func log(_ fields: [String: Any]) {
    var output = fields
    output["time"] = ISO8601DateFormatter().string(from: Date())
    if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

// 与插件一致：所有 App 的键鼠输入，不需要辅助功能或输入监控权限。
func idleSeconds() -> TimeInterval {
    guard let anyInput = CGEventType(rawValue: ~0) else { return .infinity }
    return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
}

func isRunning(_ bundleID: String) -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
}

func launch(_ bundleID: String) {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
        log(["event": "launch-failed", "reason": "app-not-found", "bundle": bundleID])
        return
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
        if let error = error {
            log(["event": "launch-failed", "reason": error.localizedDescription, "bundle": bundleID])
        }
    }
    log(["event": "launched", "bundle": bundleID])
}

let options = GuardOptions(arguments: CommandLine.arguments)

if options.statusOnly {
    let idle = idleSeconds()
    log(["event": "status", "idleSec": idle.isFinite ? (idle * 10).rounded() / 10 : -1,
         "present": idle < options.idleThreshold, "running": isRunning(options.bundleID), "bundle": options.bundleID])
    exit(0)
}

log(["event": "started", "interval": options.interval, "idleSec": options.idleThreshold,
     "graceSec": options.grace, "bundle": options.bundleID, "dryRun": options.dryRun])

var absentSince: Date?
let timer = Timer(timeInterval: options.interval, repeats: true) { _ in
    if isRunning(options.bundleID) {
        absentSince = nil
        return
    }
    guard idleSeconds() < options.idleThreshold else {
        // 人不在：不计入宽限时间。
        absentSince = nil
        return
    }
    let since = absentSince ?? Date()
    absentSince = since
    guard Date().timeIntervalSince(since) >= options.grace else { return }
    absentSince = nil
    if options.dryRun {
        log(["event": "would-launch", "bundle": options.bundleID])
    } else {
        launch(options.bundleID)
    }
}
RunLoop.main.add(timer, forMode: .common)
timer.fire()
RunLoop.main.run()
