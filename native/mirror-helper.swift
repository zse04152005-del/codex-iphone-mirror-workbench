import AppKit
import ScreenCaptureKit
import CoreGraphics
import Foundation
import ApplicationServices
import Vision

let bundleID = "com.apple.ScreenContinuity"

func mirrorWindow() async throws -> SCWindow? {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    return content.windows
        .filter { $0.owningApplication?.bundleIdentifier == bundleID && $0.frame.width > 150 && $0.frame.height > 250 }
        .sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
        .first
}

func printJSON(_ data: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: data) else { return }
    FileHandle.standardOutput.write(bytes)
}

func sendKey(_ key: CGKeyCode, command: Bool = false) {
    let flags: CGEventFlags = command ? .maskCommand : []
    let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
}

func typeText(_ value: String) throws -> [String: Any] {
    let keys: [Character: CGKeyCode] = [
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
        "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6, "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
        "6": 22, "7": 26, "8": 28, "9": 25, " ": 49, "-": 27, "=": 24,
        ",": 43, ".": 47, "/": 44, "'": 39, ";": 41, "[": 33, "]": 30,
    ]
    let isHan = value.range(of: "^[\\p{Han}]+$", options: .regularExpression) != nil
    var typed = value
    if isHan {
        let mutable = NSMutableString(string: value)
        CFStringTransform(mutable, nil, kCFStringTransformMandarinLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripDiacritics, false)
        typed = (mutable as String).replacingOccurrences(of: " ", with: "").lowercased()
    } else if !value.unicodeScalars.allSatisfy({ $0.value < 128 }) {
        throw NSError(domain: "MirrorHelper", code: 17, userInfo: [NSLocalizedDescriptionKey: "镜像键盘无法直接输入混合中文；请将连续中文单独输入，再从候选栏选择正确汉字"])
    }
    guard typed.allSatisfy({ keys[$0.lowercased().first ?? $0] != nil }) else {
        throw NSError(domain: "MirrorHelper", code: 18, userInfo: [NSLocalizedDescriptionKey: "镜像键盘暂不支持这段文字中的特殊符号"])
    }
    for character in typed {
        let lower = character.lowercased().first ?? character
        guard let code = keys[lower] else { continue }
        let flags: CGEventFlags = character.isUppercase ? .maskShift : []
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        usleep(25_000)
    }
    if isHan { return ["ok": true, "inputMode": "pinyin", "pinyin": typed, "needsCandidateSelection": true] }
    return ["ok": true, "inputMode": "physical_keys"]
}

func captureWindow(_ window: SCWindow) async throws -> CGImage {
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    config.width = max(1, Int(window.frame.width * 2))
    config.height = max(1, Int(window.frame.height * 2))
    config.showsCursor = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

func visiblePhoneRect(width: CGFloat, height: CGFloat) -> CGRect {
    guard height > width else { return CGRect(x: 0, y: 0, width: width, height: height) }
    return CGRect(x: width * 0.018, y: height * 0.053,
                  width: width * 0.964, height: height * 0.939)
}

func imageChanged(_ first: CGImage, _ second: CGImage) -> Bool {
    func pixels(_ image: CGImage) -> [UInt8] {
        var values = [UInt8](repeating: 0, count: 24 * 48 * 4)
        values.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(data: bytes.baseAddress, width: 24, height: 48,
                                          bitsPerComponent: 8, bytesPerRow: 24 * 4,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 24, height: 48))
        }
        return values
    }
    let a = pixels(first), b = pixels(second)
    var total = 0
    for i in stride(from: 0, to: a.count, by: 4) {
        total += abs(Int(a[i]) - Int(b[i]))
        total += abs(Int(a[i + 1]) - Int(b[i + 1]))
        total += abs(Int(a[i + 2]) - Int(b[i + 2]))
    }
    return Double(total) / Double(24 * 48 * 3) > 5
}

func recognizedText(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    do {
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
    } catch { return "" }
}

func connectionState(_ image: CGImage) -> String {
        let text = recognizedText(image)
        if text.contains("连接暂停") || text.contains("connection paused") { return "paused" }
        if text.contains("iphone使用中") || text.contains("锁定iphone以连接") || text.contains("iphone in use") || text.contains("lock your iphone") { return "needs_phone_lock" }
        if text.contains("无法连接") || text.contains("unable to connect") || text.contains("could not connect") { return "disconnected" }
        if text.contains("正在连接") || text.contains("connecting to iphone") { return "connecting" }
        if text.contains("需要认证") || text.contains("authentication required") { return "needs_auth" }
        return "connected"
}

func axText(_ element: AXUIElement, _ attribute: String) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return "" }
    return value as? String ?? ""
}

func findConnectButton(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 12 { return nil }
    if axText(element, kAXRoleAttribute) == (kAXButtonRole as String) {
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
            .map { axText(element, $0) }.joined(separator: " ").lowercased()
        if label.contains("连接") || label.contains("connect") || label.contains("继续") || label.contains("continue") || label.contains("resume") { return element }
    }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let children = value as? [AXUIElement] else { return nil }
    for child in children {
        if let button = findConnectButton(child, depth: depth + 1) { return button }
    }
    return nil
}

func focusMirror() async throws {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
        throw NSError(domain: "MirrorHelper", code: 19, userInfo: [NSLocalizedDescriptionKey: "iPhone 镜像应用未运行"])
    }
    _ = app.activate(options: [.activateAllWindows])
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var windows: CFTypeRef?
    if AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windows) == .success,
       let window = (windows as? [AXUIElement])?.first {
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
    for _ in 0..<20 {
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID { return }
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
    throw NSError(domain: "MirrorHelper", code: 20, userInfo: [NSLocalizedDescriptionKey: "无法将 iPhone 镜像窗口置于前台，操作未发送"])
}

func clickPhone(_ window: SCWindow, x: Double, y: Double) async {
    let display = visiblePhoneRect(width: window.frame.width, height: window.frame.height)
    let point = CGPoint(x: window.frame.minX + display.minX + display.width * x,
                        y: window.frame.minY + display.minY + display.height * y)
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    try? await Task.sleep(nanoseconds: 80_000_000)
    up?.post(tap: .cghidEventTap)
}

@main struct MirrorHelper {
    static func main() async {
        _ = NSApplication.shared
        let command = CommandLine.arguments.dropFirst().first ?? "status"
        do {
            if command == "open" {
                let url = URL(fileURLWithPath: "/System/Applications/iPhone Mirroring.app")
                let ok = NSWorkspace.shared.open(url)
                printJSON(["ok": ok])
                return
            }
            guard let window = try await mirrorWindow() else {
                if command == "status" { printJSON(["running": false, "windowVisible": false, "captureReady": false]); return }
                throw NSError(domain: "MirrorHelper", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有找到 iPhone 镜像窗口；请先在 Mac 上打开并连接它"])
            }
            if command == "status" {
                let image = try await captureWindow(window)
                let state = connectionState(image)
                printJSON([
                    "running": true,
                    "windowVisible": true,
                    "captureReady": true,
                    "connectionState": state,
                    "accessibilityTrusted": AXIsProcessTrusted(),
                    "mirrorFocused": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID,
                    "frameX": window.frame.minX,
                    "frameY": window.frame.minY,
                    "width": window.frame.width,
                    "height": window.frame.height
                ])
                return
            }
            if command == "capture" {
                let image = try await captureWindow(window)
                let rect = visiblePhoneRect(width: CGFloat(image.width), height: CGFloat(image.height)).integral
                guard let cropped = image.cropping(to: rect) else {
                    throw NSError(domain: "MirrorHelper", code: 14, userInfo: [NSLocalizedDescriptionKey: "无法裁剪手机显示区域"])
                }
                let bitmap = NSBitmapImageRep(cgImage: cropped)
                guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else {
                    throw NSError(domain: "MirrorHelper", code: 3, userInfo: [NSLocalizedDescriptionKey: "无法编码镜像画面"])
                }
                FileHandle.standardOutput.write(data)
                return
            }
            if command == "reconnect" {
                let image = try await captureWindow(window)
                if connectionState(image) == "connected" { printJSON(["ok": true, "alreadyConnected": true]); return }
                guard AXIsProcessTrusted(), let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
                    throw NSError(domain: "MirrorHelper", code: 12, userInfo: [NSLocalizedDescriptionKey: "需要辅助功能权限才能从工作台点击镜像连接按钮"])
                }
                let root = AXUIElementCreateApplication(app.processIdentifier)
                guard let button = findConnectButton(root), AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
                    throw NSError(domain: "MirrorHelper", code: 13, userInfo: [NSLocalizedDescriptionKey: "镜像中没有可用的连接按钮；请查看 Mac 上的 iPhone 镜像窗口"])
                }
                printJSON(["ok": true, "pressedConnect": true])
                return
            }
            if ["click", "press", "home", "spotlight", "find", "scroll", "type", "key"].contains(command) {
                guard AXIsProcessTrusted() else {
                    throw NSError(domain: "MirrorHelper", code: 4, userInfo: [NSLocalizedDescriptionKey: "需要在系统设置中授予终端或工作台辅助功能权限，才能手动操控镜像"])
                }
                let image = try await captureWindow(window)
                guard connectionState(image) == "connected" else {
                    throw NSError(domain: "MirrorHelper", code: 7, userInfo: [NSLocalizedDescriptionKey: "镜像尚未连接到手机，请先完成连接"])
                }
                try await focusMirror()
                if command == "find" {
                    guard CommandLine.arguments.count >= 3 else { throw NSError(domain: "MirrorHelper", code: 22, userInfo: [NSLocalizedDescriptionKey: "缺少应用搜索词"]) }
                    let search = CommandLine.arguments[2]
                    for _ in 0..<2 {
                        // Starting from Home avoids Command-3 toggling an existing Spotlight search closed.
                        try await focusMirror()
                        sendKey(18, command: true)
                        try? await Task.sleep(nanoseconds: 700_000_000)
                        let homeImage = try await captureWindow(window)
                        try await focusMirror()
                        sendKey(20, command: true)
                        try? await Task.sleep(nanoseconds: 850_000_000)
                        let spotlightImage = try await captureWindow(window)
                        if !imageChanged(homeImage, spotlightImage) { continue }
                        // Spotlight can retain an unfinished Pinyin composition from the prior task.
                        // Its clear control is at the right end of the bottom search field.
                        await clickPhone(window, x: 0.84, y: 0.93)
                        try? await Task.sleep(nanoseconds: 220_000_000)
                        let typed = try typeText(search)
                        try? await Task.sleep(nanoseconds: 700_000_000)
                        let after = try await captureWindow(window)
                        guard connectionState(after) == "connected" else { throw NSError(domain: "MirrorHelper", code: 23, userInfo: [NSLocalizedDescriptionKey: "切换应用时镜像断开"]) }
                        let bottom = CGRect(x: 0, y: CGFloat(after.height) * 0.82, width: CGFloat(after.width), height: CGFloat(after.height) * 0.18).integral
                        let queryText = after.cropping(to: bottom).map(recognizedText) ?? ""
                        let pattern = "(^|[^a-z])\(NSRegularExpression.escapedPattern(for: search.lowercased()))($|[^a-z])"
                        if queryText.range(of: pattern, options: .regularExpression) != nil {
                            printJSON(["ok": true, "search": search, "screenChanged": imageChanged(image, after), "queryVisible": true, "inputMode": typed["inputMode"] ?? "physical_keys"])
                            return
                        }
                    }
                    throw NSError(domain: "MirrorHelper", code: 24, userInfo: [NSLocalizedDescriptionKey: "未能在 Spotlight 中验证目标应用搜索词；没有继续操作旧应用"])
                }
                if command == "home" || command == "spotlight" {
                    let key: CGKeyCode = command == "home" ? 18 : 20
                    sendKey(key, command: true)
                    try? await Task.sleep(nanoseconds: 650_000_000)
                    var after = try await captureWindow(window)
                    var changed = imageChanged(image, after)
                    if !changed {
                        try await focusMirror()
                        sendKey(key, command: true)
                        try? await Task.sleep(nanoseconds: 650_000_000)
                        after = try await captureWindow(window)
                        changed = imageChanged(image, after)
                    }
                    let state = connectionState(after)
                    if state != "connected" {
                        throw NSError(domain: "MirrorHelper", code: 21, userInfo: [NSLocalizedDescriptionKey: "操作时镜像连接变为：\(state)"])
                    }
                    printJSON(["ok": true, "screenChanged": changed])
                    return
                }
                if command == "type" {
                    guard CommandLine.arguments.count >= 3 else { throw NSError(domain: "MirrorHelper", code: 8, userInfo: [NSLocalizedDescriptionKey: "缺少输入内容"]) }
                    printJSON(try typeText(CommandLine.arguments[2]))
                    return
                }
                if command == "key" {
                    let keys: [String: CGKeyCode] = ["Return": 36, "Backspace": 51, "Escape": 53, "Tab": 48]
                    guard CommandLine.arguments.count >= 3, let key = keys[CommandLine.arguments[2]] else { throw NSError(domain: "MirrorHelper", code: 9, userInfo: [NSLocalizedDescriptionKey: "按键无效"]) }
                    sendKey(key)
                    printJSON(["ok": true])
                    return
                }
                if command == "scroll" {
                    guard CommandLine.arguments.count >= 4, let amount = Int32(CommandLine.arguments[3]), (1...5).contains(amount) else { throw NSError(domain: "MirrorHelper", code: 10, userInfo: [NSLocalizedDescriptionKey: "滚动距离无效"]) }
                    let direction = CommandLine.arguments[2]
                    let isHorizontal = direction == "left" || direction == "right"
                    let vertical: Int32 = (direction == "down" || direction == "right") ? -amount * 250 : amount * 250
                    guard ["up", "down", "left", "right"].contains(direction) else { throw NSError(domain: "MirrorHelper", code: 11, userInfo: [NSLocalizedDescriptionKey: "滚动方向无效"]) }
                    let point = CGPoint(x: window.frame.midX, y: window.frame.midY)
                    // iPhone Mirroring maps Shift + vertical wheel to a horizontal swipe.
                    let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: vertical, wheel2: 0, wheel3: 0)
                    if isHorizontal { scroll?.flags = .maskShift }
                    scroll?.location = point
                    scroll?.post(tap: .cghidEventTap)
                    printJSON(["ok": true])
                    return
                }
                guard CommandLine.arguments.count >= 4,
                      let nx = Double(CommandLine.arguments[2]), let ny = Double(CommandLine.arguments[3]),
                      nx >= 0, nx <= 1, ny >= 0, ny <= 1 else {
                    throw NSError(domain: "MirrorHelper", code: 5, userInfo: [NSLocalizedDescriptionKey: "点击位置无效"])
                }
                let display = visiblePhoneRect(width: window.frame.width, height: window.frame.height)
                let point = CGPoint(x: window.frame.minX + display.minX + display.width * nx,
                                    y: window.frame.minY + display.minY + display.height * ny)
                let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
                let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
                down?.post(tap: .cghidEventTap)
                try? await Task.sleep(nanoseconds: command == "press" ? 900_000_000 : 80_000_000)
                up?.post(tap: .cghidEventTap)
                printJSON(["ok": true, "x": point.x, "y": point.y])
                return
            }
            throw NSError(domain: "MirrorHelper", code: 6, userInfo: [NSLocalizedDescriptionKey: "未知命令"])
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(1)
        }
    }
}
