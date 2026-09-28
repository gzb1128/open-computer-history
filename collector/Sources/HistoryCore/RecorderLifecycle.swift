import Darwin
import Foundation

public enum RecorderLifecycleError: LocalizedError {
    case alreadyRunning
    case stopped
    case timedOut(RecorderState, RecorderState)
    case collectorMissing(String)
    case launchFailed(String)

    public var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            return "A Computer History collector is already running."
        case .stopped:
            return "Computer History is stopped. Start it before pausing."
        case let .timedOut(expected, actual):
            return "Computer History did not reach \(expected.rawValue); current state is \(actual.rawValue)."
        case let .collectorMissing(path):
            return "Collector executable is missing at \(path). Reinstall Open Computer History."
        case let .launchFailed(message):
            return "Collector launch failed: \(message)"
        }
    }
}

/// The lock file is deliberately retained after exit. Unlinking a held flock file permits
/// another process to lock a different inode at the same path.
public final class RecorderInstanceLock {
    private let descriptor: Int32

    public init(homeURL: URL) throws {
        try FileManager.default.createDirectory(at: homeURL, withIntermediateDirectories: true)
        let path = homeURL.appendingPathComponent("collector.lock").path
        let fd = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(fd)
            if code == EWOULDBLOCK { throw RecorderLifecycleError.alreadyRunning }
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
        descriptor = fd
    }

    deinit {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

public final class RecorderLifecycle {
    public let control: RuntimeControlStore
    private let collectorURL: URL
    private let launchAgent: String?
    private let isAlive: (Int32) -> Bool
    private let startCollector: () throws -> Void
    private let signalCollector: (Int32) throws -> Void

    public init(
        homeURL: URL,
        collectorURL: URL,
        launchAgent: String? = ProcessInfo.processInfo.environment["OPEN_HISTORY_COLLECTOR_LAUNCH_AGENT"],
        isAlive: @escaping (Int32) -> Bool = RuntimeControlStore.isProcessAlive,
        startCollector: (() throws -> Void)? = nil,
        signalCollector: ((Int32) throws -> Void)? = nil
    ) {
        control = RuntimeControlStore(homeURL: homeURL)
        self.collectorURL = collectorURL
        self.launchAgent = launchAgent?.isEmpty == false ? launchAgent : nil
        self.isAlive = isAlive
        self.startCollector = startCollector ?? {
            try Self.launch(
                homeURL: homeURL,
                collectorURL: collectorURL,
                launchAgent: launchAgent
            )
        }
        self.signalCollector = signalCollector ?? { pid in
            guard kill(pid, SIGTERM) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }
    }

    public var status: RecorderRuntimeStatus {
        control.readLiveRuntime(isAlive: isAlive)
    }

    @discardableResult
    public func resume(timeout: TimeInterval = 8) throws -> RecorderRuntimeStatus {
        let wasStopped = status.state == .stopped
        try control.writeControl(.running)
        if wasStopped { try startCollector() }
        return try wait(for: .running, timeout: timeout)
    }

    @discardableResult
    public func pause(resumeAt: Date? = nil, timeout: TimeInterval = 8) throws -> RecorderRuntimeStatus {
        guard status.state != .stopped else { throw RecorderLifecycleError.stopped }
        try control.writeControl(.paused, resumeAt: resumeAt)
        return try wait(for: .paused, timeout: timeout)
    }

    @discardableResult
    public func stop(timeout: TimeInterval = 8) throws -> RecorderRuntimeStatus {
        let current = status
        guard current.state != .stopped, let pid = current.processIdentifier else {
            return current
        }
        try signalCollector(pid)
        return try wait(for: .stopped, timeout: timeout)
    }

    private func wait(for expected: RecorderState, timeout: TimeInterval) throws -> RecorderRuntimeStatus {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let current = status
            if current.state == expected { return current }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        let current = status
        let stderrURL = control.homeURL.appendingPathComponent("collector.stderr.log")
        let log = (try? String(contentsOf: stderrURL, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let log, !log.isEmpty {
            throw RecorderLifecycleError.launchFailed(log)
        }
        throw RecorderLifecycleError.timedOut(expected, current.state)
    }

    private static func launch(homeURL: URL, collectorURL: URL, launchAgent: String?) throws {
        try FileManager.default.createDirectory(at: homeURL, withIntermediateDirectories: true)
        let logURL = homeURL.appendingPathComponent("collector.stderr.log")
        FileManager.default.createFile(atPath: logURL.path, contents: Data())
        if let launchAgent, !launchAgent.isEmpty {
            let command = Process()
            command.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            command.arguments = ["kickstart", "gui/\(getuid())/\(launchAgent)"]
            let errorURL = homeURL.appendingPathComponent("launchctl.stderr.log")
            FileManager.default.createFile(atPath: errorURL.path, contents: Data())
            let errorHandle = try FileHandle(forWritingTo: errorURL)
            defer { try? errorHandle.close() }
            command.standardError = errorHandle
            try command.run()
            command.waitUntilExit()
            if command.terminationStatus != 0 {
                let detail = (try? String(contentsOf: errorURL, encoding: .utf8)) ?? ""
                throw RecorderLifecycleError.launchFailed(
                    "launchctl kickstart \(launchAgent) exited \(command.terminationStatus): \(detail)"
                )
            }
            return
        }
        guard FileManager.default.isExecutableFile(atPath: collectorURL.path) else {
            throw RecorderLifecycleError.collectorMissing(collectorURL.path)
        }
        let command = Process()
        command.executableURL = collectorURL
        command.arguments = ["record", "--no-prompt"]
        command.environment = ProcessInfo.processInfo.environment.merging([
            "OPEN_COMPUTER_HISTORY_HOME": homeURL.path,
        ]) { _, replacement in replacement }
        let log = try FileHandle(forWritingTo: logURL)
        defer { try? log.close() }
        command.standardOutput = log
        command.standardError = log
        try command.run()
    }
}
