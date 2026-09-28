import Foundation

public enum CaptureConfig {
    public static func textCaptureEnabled(homeURL: URL) throws -> Bool {
        let config = try read(homeURL: homeURL)
        return config["captureText"] as? Bool ?? true
    }

    public static func setTextCaptureEnabled(_ enabled: Bool, homeURL: URL) throws {
        var config = try read(homeURL: homeURL)
        config["captureText"] = enabled
        let data = try JSONSerialization.data(
            withJSONObject: config,
            options: [.prettyPrinted, .sortedKeys]
        )
        try FileManager.default.createDirectory(at: homeURL, withIntermediateDirectories: true)
        try data.write(to: homeURL.appendingPathComponent("config.json"), options: .atomic)
    }

    private static func read(homeURL: URL) throws -> [String: Any] {
        let url = homeURL.appendingPathComponent("config.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let data = try Data(contentsOf: url)
        guard let config = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(
                domain: "OpenHistoryConfig", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "config.json must be a JSON object"]
            )
        }
        return config
    }
}
