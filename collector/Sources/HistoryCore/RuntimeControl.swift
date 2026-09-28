import Foundation
import Darwin

public enum RecorderState: String, Codable, Sendable {
    case stopped
    case running
    case paused
}

public struct RecorderRuntimeStatus: Codable, Sendable {
    public let state: RecorderState
    public let processIdentifier: Int32?
    public let eventStreamRootPath: String
    public let currentSegmentEventsPath: String?
    public let currentSegmentMetadataPath: String?
    public let suppressedEventsPath: String?
    public let startedAt: Date?
    public let endedAt: Date?
    public let accessibility: Bool?
    public let inputMonitoring: Bool?
    public let permissionCheckedAt: Date?

    public init(
        state: RecorderState,
        processIdentifier: Int32?,
        eventStreamRootPath: String,
        currentSegmentEventsPath: String?,
        currentSegmentMetadataPath: String?,
        suppressedEventsPath: String?,
        startedAt: Date?,
        endedAt: Date?,
        accessibility: Bool? = nil,
        inputMonitoring: Bool? = nil,
        permissionCheckedAt: Date? = nil
    ) {
        self.state = state
        self.processIdentifier = processIdentifier
        self.eventStreamRootPath = eventStreamRootPath
        self.currentSegmentEventsPath = currentSegmentEventsPath
        self.currentSegmentMetadataPath = currentSegmentMetadataPath
        self.suppressedEventsPath = suppressedEventsPath
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring
        self.permissionCheckedAt = permissionCheckedAt
    }
}

public struct RecorderControlRequest: Codable, Sendable {
    public let state: RecorderState
    public let updatedAt: Date
    public let resumeAt: Date?

    public init(
        state: RecorderState,
        updatedAt: Date = Date(),
        resumeAt: Date? = nil
    ) {
        self.state = state
        self.updatedAt = updatedAt
        self.resumeAt = resumeAt
    }
}

public final class RuntimeControlStore {
    public let homeURL: URL
    public let runtimeURL: URL
    public let controlURL: URL

    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(homeURL: URL) {
        self.homeURL = homeURL
        self.runtimeURL = homeURL.appendingPathComponent("runtime.json")
        self.controlURL = homeURL.appendingPathComponent("control.json")
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO8601 timestamp: \(value)"
            )
        }
    }

    public func writeRuntime(_ status: RecorderRuntimeStatus) throws {
        try FileManager.default.createDirectory(
            at: homeURL,
            withIntermediateDirectories: true
        )
        try encoder.encode(status).write(to: runtimeURL, options: .atomic)
    }

    public func readRuntime() -> RecorderRuntimeStatus? {
        guard let data = try? Data(contentsOf: runtimeURL) else {
            return nil
        }
        return try? decoder.decode(RecorderRuntimeStatus.self, from: data)
    }

    public func readLiveRuntime(
        isAlive: (Int32) -> Bool = RuntimeControlStore.isProcessAlive
    ) -> RecorderRuntimeStatus {
        guard let runtime = readRuntime(),
              runtime.state != .stopped,
              let pid = runtime.processIdentifier,
              pid > 0,
              isAlive(pid)
        else {
            return stoppedStatus()
        }
        return runtime
    }

    public func stoppedStatus() -> RecorderRuntimeStatus {
        let previous = readRuntime()
        return RecorderRuntimeStatus(
            state: .stopped,
            processIdentifier: nil,
            eventStreamRootPath: homeURL.path,
            currentSegmentEventsPath: nil,
            currentSegmentMetadataPath: nil,
            suppressedEventsPath: nil,
            startedAt: previous?.startedAt,
            endedAt: previous?.endedAt,
            accessibility: previous?.accessibility,
            inputMonitoring: previous?.inputMonitoring,
            permissionCheckedAt: previous?.permissionCheckedAt
        )
    }

    public static func isProcessAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        guard kill(pid, 0) == 0 || errno == EPERM else { return false }
        var path = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
        return URL(fileURLWithPath: String(cString: path)).lastPathComponent == "open-history"
    }

    public func writeControl(_ state: RecorderState, resumeAt: Date? = nil) throws {
        try FileManager.default.createDirectory(
            at: homeURL,
            withIntermediateDirectories: true
        )
        try encoder.encode(RecorderControlRequest(state: state, resumeAt: resumeAt))
            .write(to: controlURL, options: .atomic)
    }

    public func readControl() -> RecorderControlRequest? {
        guard let data = try? Data(contentsOf: controlURL) else {
            return nil
        }
        return try? decoder.decode(RecorderControlRequest.self, from: data)
    }

    public func decodeControl(_ data: Data) throws -> RecorderControlRequest {
        try decoder.decode(RecorderControlRequest.self, from: data)
    }
}
