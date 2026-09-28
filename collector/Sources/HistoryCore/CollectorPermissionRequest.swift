import Darwin
import Foundation

public enum CollectorPermissionKind: Sendable {
    case accessibility
    case inputMonitoring

    fileprivate var argument: String {
        switch self {
        case .accessibility: return "--request-accessibility"
        case .inputMonitoring: return "--request-input-monitoring"
        }
    }
}

public struct CollectorPermissionResult: Decodable, Sendable {
    public let accessibility: Bool
    public let inputMonitoring: Bool
    public let checkedAt: Date

    private enum CodingKeys: String, CodingKey {
        case accessibility
        case inputMonitoring
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accessibility = try container.decode(Bool.self, forKey: .accessibility)
        inputMonitoring = try container.decode(Bool.self, forKey: .inputMonitoring)
        checkedAt = Date()
    }
}

/// A single permission check in a launchd-owned process, with no persistent service.
public final class CollectorPermissionRequester {
    public let homeURL: URL
    public let collectorURL: URL
    private let runLaunchctl: ([String]) throws -> Void

    public init(
        homeURL: URL,
        collectorURL: URL,
        runLaunchctl: (([String]) throws -> Void)? = nil
    ) {
        self.homeURL = homeURL
        self.collectorURL = collectorURL
        self.runLaunchctl = runLaunchctl ?? Self.runLaunchctlCommand
    }

    public func request(
        _ kind: CollectorPermissionKind,
        timeout: TimeInterval = 60
    ) throws -> CollectorPermissionResult {
        guard FileManager.default.isExecutableFile(atPath: collectorURL.path) else {
            throw RecorderLifecycleError.collectorMissing(collectorURL.path)
        }
        let directory = homeURL.appendingPathComponent(
            "permission-request-\(UUID().uuidString.lowercased())", isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let label = "dev.opencomputerhistory.permission.\(UUID().uuidString.lowercased())"
        let plistURL = directory.appendingPathComponent("agent.plist")
        let outputURL = directory.appendingPathComponent("result.json")
        let errorURL = directory.appendingPathComponent("stderr.log")
        let service: [String: Any] = [
            "Label": label,
            "ProgramArguments": [collectorURL.path, "permissions", kind.argument],
            "RunAtLoad": true,
            "KeepAlive": false,
            "StandardOutPath": outputURL.path,
            "StandardErrorPath": errorURL.path,
            "EnvironmentVariables": [
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "OPEN_COMPUTER_HISTORY_HOME": homeURL.path,
            ],
        ]
        do {
            let plist = try PropertyListSerialization.data(
                fromPropertyList: service, format: .xml, options: 0
            )
            try plist.write(to: plistURL, options: .atomic)
            let domain = "gui/\(getuid())"
            try runLaunchctl(["bootstrap", domain, plistURL.path])
            let deadline = Date().addingTimeInterval(timeout)
            var result: CollectorPermissionResult?
            repeat {
                if let data = try? Data(contentsOf: outputURL), !data.isEmpty,
                   let decoded = try? JSONDecoder().decode(CollectorPermissionResult.self, from: data) {
                    result = decoded
                    break
                }
                Thread.sleep(forTimeInterval: 0.1)
            } while Date() < deadline
            let stderrText = (try? String(contentsOf: errorURL, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let result else {
                throw RecorderLifecycleError.launchFailed(
                    "One-time launchd permission request did not return within \(Int(timeout)) seconds." +
                    (stderrText.map { " \($0)" } ?? "")
                )
            }
            try runLaunchctl(["bootout", "\(domain)/\(label)"])
            try FileManager.default.removeItem(at: directory)
            return result
        } catch {
            // A failed bootstrap may leave no job; a failed wait may leave a live prompt.
            // Always attempt to terminate the unique job before removing its plist.
            let domain = "gui/\(getuid())"
            do { try runLaunchctl(["bootout", "\(domain)/\(label)"]) }
            catch {
                fputs("One-time permission job cleanup failed: \(error)\n", stderr)
            }
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    private static func runLaunchctlCommand(_ arguments: [String]) throws {
        let command = Process()
        command.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        command.arguments = arguments
        let log = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("open-history-launchctl-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: log.path, contents: Data())
        defer { try? FileManager.default.removeItem(at: log) }
        let handle = try FileHandle(forWritingTo: log)
        defer { try? handle.close() }
        command.standardError = handle
        try command.run()
        command.waitUntilExit()
        if command.terminationStatus != 0 {
            let detail = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
            throw RecorderLifecycleError.launchFailed(
                "launchctl \(arguments.joined(separator: " ")) exited \(command.terminationStatus): \(detail)"
            )
        }
    }
}
