import AppKit
import HistoryCore
import SwiftUI

@main
struct OpenHistoryMenuApp: App {
    @StateObject private var controller = MenuController()
    @AppStorage("openHistoryCaptureConsent") private var captureConsent = false

    var body: some Scene {
        MenuBarExtra {
            ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Open Computer History").font(.headline)
                Text(controller.statusLabel)
                    .foregroundStyle(controller.status.state == .running ? .green : .secondary)
                Text("Records app and window activity, clicks, keystroke context, and accessible UI text locally. Sensitive input is filtered by the collector policy. Review the history folder and policy before starting.")
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                Toggle("I want to start local capture", isOn: $captureConsent)
                    .disabled(controller.status.state != .stopped)
                HStack {
                    if controller.status.state == .stopped {
                        Button("Start") { controller.resume() }
                            .disabled(!captureConsent || controller.isBusy)
                    } else if controller.status.state == .running {
                        Button("Pause") { controller.pause(until: nil) }
                            .disabled(controller.isBusy)
                        Button("Pause 30 min") {
                            controller.pause(until: Date().addingTimeInterval(1800))
                        }.disabled(controller.isBusy)
                        Button("Pause 1 hour") {
                            controller.pause(until: Date().addingTimeInterval(3600))
                        }.disabled(controller.isBusy)
                        Button("Until tomorrow") { controller.pauseUntilTomorrow() }
                            .disabled(controller.isBusy)
                    } else {
                        Button("Resume") { controller.resume() }
                            .disabled(controller.isBusy)
                    }
                    if controller.status.state != .stopped {
                        Button("Stop") { controller.stop() }.disabled(controller.isBusy)
                    }
                }
                Divider()
                Text("Permissions for the installed collector").font(.subheadline)
                permissionRow("Accessibility", allowed: controller.status.accessibility,
                              request: { controller.requestPermission(.accessibility) },
                              settings: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                permissionRow("Input Monitoring", allowed: controller.status.inputMonitoring,
                              request: { controller.requestPermission(.inputMonitoring) },
                              settings: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
                if let checkedAt = controller.status.permissionCheckedAt {
                    Text("Last collector check: \(checkedAt.formatted())" +
                         (controller.status.state == .stopped ? " (historical)" : ""))
                        .font(.caption)
                }
                Button("Refresh last reported status") { controller.refresh() }
                Text("Permission results are current only while the background collector is running. Request buttons launch the same installed executable once; after granting access, start or resume to confirm it in the collector.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Divider()
                Text("Capture settings").font(.subheadline)
                Toggle("Include typed, selected, and terminal text", isOn: Binding(
                    get: { controller.captureText },
                    set: { controller.setCaptureText($0) }
                ))
                Text("Turning this off still allows accessibility tree and element values to be recorded. The change applies on the next collector start.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Generated summaries are an optional install choice and may send captured history to the configured model.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let error = controller.recentError {
                    Text(error).foregroundStyle(.red).font(.caption)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let message = controller.infoMessage {
                    Text(message).font(.caption)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("History Folder") { controller.showHistory() }
                    Button("Clear Last 10 Min") { controller.confirmClear(.lastTenMinutes) }
                    Button("Clear All") { controller.confirmClear(.all) }
                    Spacer()
                    Button("Quit Menu") { NSApplication.shared.terminate(nil) }
                }
            }
            .padding(14)
            }
            .frame(width: 390)
            .frame(maxHeight: 680)
        } label: {
            Image(systemName: controller.iconName)
        }
        .menuBarExtraStyle(.window)
    }

    private func permissionRow(
        _ name: String,
        allowed: Bool?,
        request: @escaping () -> Void,
        settings: String
    ) -> some View {
        HStack {
            Text(name)
            Spacer()
            Text(allowed.map { $0 ? "Allowed" : "Needed" } ?? "Unknown")
                .foregroundStyle(allowed == true ? .green : .secondary)
            Button("Request") { request() }
            Button("Settings") {
                if let url = URL(string: settings) { NSWorkspace.shared.open(url) }
            }
        }
    }
}

@MainActor
final class MenuController: ObservableObject {
    @Published private(set) var status: RecorderRuntimeStatus
    @Published private(set) var captureText = true
    @Published private(set) var isBusy = false
    @Published var recentError: String?
    @Published var infoMessage: String?

    private let homeURL: URL
    private let lifecycle: RecorderLifecycle
    private let collectorURL: URL
    private var timer: Timer?

    init() {
        if let override = ProcessInfo.processInfo.environment["OPEN_COMPUTER_HISTORY_HOME"],
           !override.isEmpty {
            homeURL = URL(fileURLWithPath: NSString(string: override).expandingTildeInPath)
        } else {
            homeURL = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".open-codex-computer-history", isDirectory: true)
        }
        collectorURL = (Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]))
            .deletingLastPathComponent().appendingPathComponent("open-history")
        lifecycle = RecorderLifecycle(homeURL: homeURL, collectorURL: collectorURL)
        status = lifecycle.status
        do { captureText = try CaptureConfig.textCaptureEnabled(homeURL: homeURL) }
        catch { recentError = "Could not read capture settings: \(error.localizedDescription)" }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    var statusLabel: String {
        switch status.state {
        case .running: return "Running"
        case .paused: return "Paused"
        case .stopped: return "Stopped"
        }
    }

    var iconName: String {
        switch status.state {
        case .running: return "clock.arrow.circlepath"
        case .paused: return "pause.circle"
        case .stopped: return "clock"
        }
    }

    func refresh() {
        status = lifecycle.status
        if status.state == .stopped,
           recentError == nil,
           let runDate = status.endedAt ?? status.startedAt {
            let logURL = homeURL.appendingPathComponent("collector.stderr.log")
            let attributes = try? FileManager.default.attributesOfItem(atPath: logURL.path)
            if let modifiedAt = attributes?[.modificationDate] as? Date,
               modifiedAt >= runDate {
                let log = (try? String(contentsOf: logURL, encoding: .utf8))?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let log, !log.isEmpty { recentError = log }
            }
        }
    }

    func resume() { perform { try $0.resume() } }
    func pause(until date: Date?) { perform { try $0.pause(resumeAt: date) } }
    func stop() { perform { try $0.stop() } }

    func pauseUntilTomorrow() {
        pause(until: Calendar.current.date(
            byAdding: .day,
            value: 1,
            to: Calendar.current.startOfDay(for: Date())
        ))
    }

    private func perform(_ action: @escaping (RecorderLifecycle) throws -> RecorderRuntimeStatus) {
        guard !isBusy else { return }
        isBusy = true
        recentError = nil
        infoMessage = nil
        let lifecycle = self.lifecycle
        Task.detached {
            let result = Result { try action(lifecycle) }
            await MainActor.run {
                self.isBusy = false
                switch result {
                case .success(let status): self.status = status
                case .failure(let error): self.recentError = error.localizedDescription
                }
                self.refresh()
            }
        }
    }

    func requestPermission(_ kind: CollectorPermissionKind) {
        guard !isBusy else { return }
        isBusy = true
        recentError = nil
        infoMessage = nil
        let executable = collectorURL
        let home = homeURL
        Task.detached {
            let result = Result { () throws -> CollectorPermissionResult in
                try CollectorPermissionRequester(homeURL: home, collectorURL: executable)
                    .request(kind)
            }
            await MainActor.run {
                self.isBusy = false
                switch result {
                case .success(let report):
                    let ax = report.accessibility ? "allowed" : "needed"
                    let input = report.inputMonitoring ? "allowed" : "needed"
                    self.infoMessage = "Launchd request at \(report.checkedAt.formatted()): Accessibility \(ax), Input Monitoring \(input). Start the collector to verify background access."
                case .failure(let error): self.recentError = error.localizedDescription
                }
                self.refresh()
            }
        }
    }

    func setCaptureText(_ enabled: Bool) {
        do {
            try CaptureConfig.setTextCaptureEnabled(enabled, homeURL: homeURL)
            captureText = enabled
            recentError = nil
            infoMessage = status.state == .stopped ? nil : "Capture text setting applies after Stop and Start."
        } catch {
            recentError = "Could not save capture setting: \(error.localizedDescription)"
        }
    }

    func confirmClear(_ scope: HistoryClearScope) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        switch scope {
        case .all: alert.messageText = "Clear all history?"
        default: alert.messageText = "Clear the last 10 minutes?"
        }
        alert.informativeText = "Matching events and generated memories will be deleted. This cannot be undone."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do { _ = try HistoryMaintenance.clear(homeURL: homeURL, scope: scope) }
        catch { recentError = "Could not clear history: \(error.localizedDescription)" }
    }

    func showHistory() {
        do {
            try FileManager.default.createDirectory(at: homeURL, withIntermediateDirectories: true)
            NSWorkspace.shared.open(homeURL)
        } catch { recentError = "Could not open history: \(error.localizedDescription)" }
    }

}
