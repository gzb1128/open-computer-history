import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import HistoryCore

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "help"
let homeURL = historyHome()

switch command {
case "record":
    runRecorder(arguments: Array(arguments.dropFirst()), homeURL: homeURL)
case "sample":
    writeSample(homeURL: homeURL)
case "permissions":
    printPermissions(arguments: Array(arguments.dropFirst()))
case "status":
    printStatus(homeURL: homeURL)
case "pause":
    changeRecorderState(.paused, arguments: Array(arguments.dropFirst()), homeURL: homeURL)
case "resume", "start":
    changeRecorderState(.running, arguments: [], homeURL: homeURL)
case "stop":
    changeRecorderState(.stopped, arguments: [], homeURL: homeURL)
case "contract-probe":
    probeControl(arguments: Array(arguments.dropFirst()), homeURL: homeURL)
default:
    printUsage()
}

func historyHome() -> URL {
    if let override = ProcessInfo.processInfo.environment["OPEN_COMPUTER_HISTORY_HOME"],
       !override.isEmpty
    {
        return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath)
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".open-codex-computer-history", isDirectory: true)
}

func runRecorder(arguments: [String], homeURL: URL) {
    let instanceLock: RecorderInstanceLock
    do {
        instanceLock = try RecorderInstanceLock(homeURL: homeURL)
    } catch {
        fputs("Collector cannot start: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    defer { withExtendedLifetime(instanceLock) {} }
    let requestPermissions = !arguments.contains("--no-prompt")
    if requestPermissions {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestListenEventAccess()
    }

    let accessibility = AXIsProcessTrusted()
    let inputMonitoring = CGPreflightListenEventAccess()
    guard accessibility, inputMonitoring else {
        do {
            try RuntimeControlStore(homeURL: homeURL).writeRuntime(
                RecorderRuntimeStatus(
                    state: .stopped,
                    processIdentifier: nil,
                    eventStreamRootPath: homeURL.path,
                    currentSegmentEventsPath: nil,
                    currentSegmentMetadataPath: nil,
                    suppressedEventsPath: nil,
                    startedAt: nil,
                    endedAt: Date(),
                    accessibility: accessibility,
                    inputMonitoring: inputMonitoring,
                    permissionCheckedAt: Date()
                )
            )
        } catch {
            fputs("Failed to report collector permissions: \(error)\n", stderr)
        }
        fputs(
            "Collector permissions denied: Accessibility=\(accessibility), Input Monitoring=\(inputMonitoring). " +
                "Grant the installed open-history executable in System Settings, then start again.\n",
            stderr
        )
        exit(2)
    }

    do {
        var policy = loadPolicy(homeURL: homeURL)
        if arguments.contains("--capture-text") {
            policy.captureText = true
        }
        let store = try SegmentStore(homeURL: homeURL)
        let recorder = HistoryRecorder(store: store, policy: policy)
        try recorder.start()
        print("Recording interaction events to \(store.eventsURL.path)")
        print("Press Control-C to stop.")

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        interruptSource.setEventHandler {
            recorder.stop(reason: "user_interrupt")
            CFRunLoopStop(CFRunLoopGetMain())
        }
        terminateSource.setEventHandler {
            recorder.stop(reason: "terminated")
            CFRunLoopStop(CFRunLoopGetMain())
        }
        interruptSource.resume()
        terminateSource.resume()

        if let duration = optionValue("--duration", in: arguments).flatMap(Double.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                recorder.stop(reason: "duration_elapsed")
                CFRunLoopStop(CFRunLoopGetMain())
            }
        }
        CFRunLoopRun()
        recorder.stop(reason: "run_loop_ended")
    } catch {
        fputs("Recorder failed: \(error)\n", stderr)
        exit(1)
    }
}

func loadPolicy(homeURL: URL) -> ObservationPolicy {
    let configURL = homeURL.appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configURL),
          let policy = try? JSONDecoder().decode(ObservationPolicy.self, from: data)
    else {
        return ObservationPolicy()
    }
    return policy
}

func writeSample(homeURL: URL) {
    do {
        let store = try SegmentStore(homeURL: homeURL)
        let timestamp = Date()
        let app = EventStreamApp(
            name: "Open History Sample",
            secureInput: false,
            processIdentifier: nil,
            bundleIdentifier: "org.openhistory.sample"
        )
        let window = EventStreamWindow(
            title: "Sample workflow",
            url: nil,
            windowID: nil
        )
        let element = EventStreamAXElement(
            role: "AXTextArea",
            subrole: nil,
            title: "Research notes",
            description: nil,
            value: nil,
            placeholder: nil,
            identifier: "notes"
        )
        try store.append(HistoryEvent(
            id: 1,
            timestamp: timestamp,
            kind: .sessionStarted,
            app: app,
            window: window
        ))
        try store.append(HistoryEvent(
            id: 2,
            timestamp: timestamp,
            kind: .windowChanged,
            app: app,
            window: window,
            ax: EventStreamAXTree(
                mode: .fullTree,
                text: "AXWindow[Sample workflow] > AXTextArea[Research notes]"
            )
        ))
        try store.append(HistoryEvent(
            id: 3,
            timestamp: timestamp,
            kind: .keyboardTextInput,
            app: app,
            window: window,
            keyboard: EventStreamKeyboardInteraction(
                text: nil,
                keyEquivalent: nil,
                modifiers: [],
                target: element
            )
        ))
        try store.finish(reason: "sample")
        print(store.eventsURL.path)
    } catch {
        fputs("Failed to write sample: \(error)\n", stderr)
        exit(1)
    }
}

func printPermissions(arguments: [String]) {
    let requestAX = arguments.contains("--request-accessibility") ||
        (!arguments.contains("--no-prompt") && !arguments.contains("--request-input-monitoring"))
    let requestInput = arguments.contains("--request-input-monitoring") ||
        (!arguments.contains("--no-prompt") && !arguments.contains("--request-accessibility"))
    if requestAX {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }
    if requestInput {
        _ = CGRequestListenEventAccess()
    }
    let status: [String: Any] = [
        "accessibility": AXIsProcessTrusted(),
        "inputMonitoring": CGPreflightListenEventAccess(),
        "source": "thisInvocation",
    ]
    if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]),
       let output = String(data: data, encoding: .utf8)
    {
        print(output)
    }
}

func printStatus(homeURL: URL) {
    let segmentsURL = homeURL.appendingPathComponent("segments", isDirectory: true)
    let segments = (try? FileManager.default.contentsOfDirectory(
        at: segmentsURL,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
    )) ?? []
    let runtime = RuntimeControlStore(homeURL: homeURL).readLiveRuntime()
    let permissions: [String: Any]
    if runtime.state != .stopped,
       let accessibility = runtime.accessibility,
       let inputMonitoring = runtime.inputMonitoring,
       let checkedAt = runtime.permissionCheckedAt {
        permissions = [
            "source": "collector",
            "accessibility": accessibility,
            "inputMonitoring": inputMonitoring,
            "checkedAt": ISO8601DateFormatter().string(from: checkedAt),
        ]
    } else {
        permissions = ["source": "unknown"]
    }
    let status: [String: Any] = [
        "home": homeURL.path,
        "segments": segments.count,
        "permissions": permissions,
        "state": runtime.state.rawValue,
        "processIdentifier": runtime.processIdentifier.map { $0 as Any } ?? NSNull(),
        "currentSegmentEventsPath": runtime.currentSegmentEventsPath.map { $0 as Any } ?? NSNull(),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]),
       let output = String(data: data, encoding: .utf8)
    {
        print(output)
    }
}

func changeRecorderState(_ state: RecorderState, arguments: [String], homeURL: URL) {
    do {
        let lifecycle = RecorderLifecycle(
            homeURL: homeURL,
            collectorURL: URL(fileURLWithPath: CommandLine.arguments[0])
        )
        let result: RecorderRuntimeStatus
        switch state {
        case .running:
            result = try lifecycle.resume()
        case .paused:
            result = try lifecycle.pause(resumeAt: pauseDate(arguments: arguments))
        case .stopped:
            result = try lifecycle.stop()
        }
        print(result.state.rawValue)
    } catch {
        fputs("Failed to update recorder state: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

func pauseDate(arguments: [String]) -> Date? {
    switch optionValue("--for", in: arguments) {
    case "30m":
        return Date().addingTimeInterval(30 * 60)
    case "1h":
        return Date().addingTimeInterval(60 * 60)
    case "tomorrow":
        return Calendar.current.date(
            byAdding: .day,
            value: 1,
            to: Calendar.current.startOfDay(for: Date())
        )
    case nil:
        return nil
    default:
        fputs("Pause duration must be 30m, 1h, or tomorrow.\n", stderr)
        exit(2)
    }
}

func probeControl(arguments: [String], homeURL: URL) {
    if arguments.first == "--lock" {
        guard arguments.count >= 2 else {
            fputs("contract-probe --lock requires a home path.\n", stderr)
            exit(2)
        }
        do {
            let lock = try RecorderInstanceLock(homeURL: URL(fileURLWithPath: arguments[1]))
            print("locked")
            fflush(stdout)
            if let seconds = optionValue("--hold", in: arguments).flatMap(Double.init), seconds > 0 {
                Thread.sleep(forTimeInterval: seconds)
            }
            withExtendedLifetime(lock) {}
        } catch {
            fputs("Lock probe failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
        return
    }
    guard let path = arguments.first else {
        fputs("contract-probe requires a control JSON path.\n", stderr)
        exit(2)
    }
    do {
        let request = try RuntimeControlStore(homeURL: homeURL)
            .decodeControl(Data(contentsOf: URL(fileURLWithPath: path)))
        var output = [
            "state": request.state.rawValue,
            "updatedAt": ISO8601DateFormatter().string(from: request.updatedAt),
        ]
        if let resumeAt = request.resumeAt {
            output["resumeAt"] = ISO8601DateFormatter().string(from: resumeAt)
        }
        let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    } catch {
        fputs("Failed to decode control request: \(error)\n", stderr)
        exit(1)
    }
}

func optionValue(_ option: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: option), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

func printUsage() {
    print("""
    Open Codex Computer History

    Usage:
      open-history record [--duration SECONDS] [--capture-text] [--no-prompt]
      open-history sample
      open-history permissions [--no-prompt|--request-accessibility|--request-input-monitoring]
      open-history status
      open-history start|stop
      open-history pause [--for 30m|1h|tomorrow]
      open-history resume

    Environment:
      OPEN_COMPUTER_HISTORY_HOME  Override ~/.open-codex-computer-history
    """)
}
