import Foundation
import XCTest
@testable import HistoryCore

final class RecorderLifecycleTests: XCTestCase {
    private func temporaryHome() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    func testControlAcceptsWholeAndFractionalISOTimestamps() throws {
        let store = RuntimeControlStore(homeURL: temporaryHome())
        for (timestamp, seconds) in [
            ("2026-09-28T06:00:00Z", 0.0),
            ("2026-09-28T06:00:00.123Z", 0.123),
        ] {
            let json = """
            {"state":"paused","updatedAt":"\(timestamp)","resumeAt":"\(timestamp)"}
            """
            let request = try store.decodeControl(Data(json.utf8))
            XCTAssertEqual(request.state, .paused)
            XCTAssertEqual(request.resumeAt!.timeIntervalSince(request.updatedAt), 0)
            XCTAssertEqual(request.updatedAt.timeIntervalSince1970.truncatingRemainder(dividingBy: 1), seconds, accuracy: 0.001)
        }
    }

    func testStaleRuntimeIsStoppedButPreservesLastObservedPermission() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let store = RuntimeControlStore(homeURL: home)
        try store.writeRuntime(RecorderRuntimeStatus(
            state: .running,
            processIdentifier: 1234,
            eventStreamRootPath: home.path,
            currentSegmentEventsPath: "/unused",
            currentSegmentMetadataPath: nil,
            suppressedEventsPath: nil,
            startedAt: Date(),
            endedAt: nil,
            accessibility: false,
            inputMonitoring: true,
            permissionCheckedAt: Date()
        ))
        let status = store.readLiveRuntime(isAlive: { _ in false })
        XCTAssertEqual(status.state, .stopped)
        XCTAssertNil(status.processIdentifier)
        XCTAssertNil(status.currentSegmentEventsPath)
        XCTAssertEqual(status.accessibility, false)
    }

    func testUnrelatedLiveProcessIsNotCollector() {
        XCTAssertFalse(RuntimeControlStore.isProcessAlive(getpid()))
    }

    func testInstanceLockExcludesSecondCollectorAndReleasesOnDeinit() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        var first: RecorderInstanceLock? = try RecorderInstanceLock(homeURL: home)
        XCTAssertThrowsError(try RecorderInstanceLock(homeURL: home))
        first = nil
        _ = first
        XCTAssertNoThrow(try RecorderInstanceLock(homeURL: home))
    }

    func testLifecycleStartsPausedRunningAndStopsWithInjectedActions() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let store = RuntimeControlStore(homeURL: home)
        var launchCount = 0
        var signalCount = 0
        func runtime(_ state: RecorderState) throws {
            try store.writeRuntime(RecorderRuntimeStatus(
                state: state,
                processIdentifier: state == .stopped ? nil : 1234,
                eventStreamRootPath: home.path,
                currentSegmentEventsPath: nil,
                currentSegmentMetadataPath: nil,
                suppressedEventsPath: nil,
                startedAt: nil,
                endedAt: nil
            ))
        }
        let lifecycle = RecorderLifecycle(
            homeURL: home,
            collectorURL: URL(fileURLWithPath: "/unused"),
            launchAgent: nil,
            isAlive: { $0 == 1234 },
            startCollector: {
                launchCount += 1
                try runtime(.running)
            },
            signalCollector: { pid in
                XCTAssertEqual(pid, 1234)
                signalCount += 1
                try runtime(.stopped)
            }
        )
        XCTAssertThrowsError(try lifecycle.pause(timeout: 0))
        XCTAssertEqual(try lifecycle.resume(timeout: 0).state, .running)
        XCTAssertEqual(launchCount, 1)
        try runtime(.paused)
        XCTAssertEqual(try lifecycle.pause(timeout: 0).state, .paused)
        XCTAssertEqual(store.readControl()?.state, .paused)
        try runtime(.running)
        XCTAssertEqual(try lifecycle.resume(timeout: 0).state, .running)
        XCTAssertEqual(launchCount, 1)
        XCTAssertEqual(try lifecycle.stop(timeout: 0).state, .stopped)
        XCTAssertEqual(signalCount, 1)
    }

    func testCaptureSettingPreservesOtherConfiguration() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let url = home.appendingPathComponent("config.json")
        try Data("{\"summaryModel\":\"custom-model\",\"captureText\":true}".utf8).write(to: url)
        try CaptureConfig.setTextCaptureEnabled(false, homeURL: home)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        XCTAssertEqual(object["summaryModel"] as? String, "custom-model")
        XCTAssertEqual(object["captureText"] as? Bool, false)
    }

    func testMalformedConfigIsNotOverwritten() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let url = home.appendingPathComponent("config.json")
        let invalid = Data("{bad json".utf8)
        try invalid.write(to: url)
        XCTAssertThrowsError(try CaptureConfig.setTextCaptureEnabled(false, homeURL: home))
        XCTAssertEqual(try Data(contentsOf: url), invalid)
    }

    func testOneShotPermissionJobUsesCollectorAndCleansUp() throws {
        let home = temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let executable = home.appendingPathComponent("open-history")
        try Data("#!/bin/sh\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        var bootstrappedLabel: String?
        var bootoutCount = 0
        let requester = CollectorPermissionRequester(
            homeURL: home,
            collectorURL: executable,
            runLaunchctl: { arguments in
                if arguments[0] == "bootstrap" {
                    let data = try Data(contentsOf: URL(fileURLWithPath: arguments[2]))
                    let plist = try XCTUnwrap(
                        PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
                    )
                    bootstrappedLabel = plist["Label"] as? String
                    XCTAssertEqual(plist["RunAtLoad"] as? Bool, true)
                    XCTAssertEqual(plist["KeepAlive"] as? Bool, false)
                    XCTAssertEqual(plist["ProgramArguments"] as? [String], [
                        executable.path, "permissions", "--request-accessibility",
                    ])
                    let output = try XCTUnwrap(plist["StandardOutPath"] as? String)
                    try Data("{\"accessibility\":true,\"inputMonitoring\":false}".utf8)
                        .write(to: URL(fileURLWithPath: output))
                } else {
                    bootoutCount += 1
                    XCTAssertTrue(arguments[1].hasSuffix(bootstrappedLabel ?? "missing"))
                }
            }
        )
        let result = try requester.request(.accessibility, timeout: 0)
        XCTAssertTrue(result.accessibility)
        XCTAssertFalse(result.inputMonitoring)
        XCTAssertEqual(bootoutCount, 1)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: home.path)
        XCTAssertEqual(leftovers, ["open-history"])
    }
}
