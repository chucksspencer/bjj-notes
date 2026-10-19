import AVFoundation
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Reads a shared photo or video: when it was taken, its size and length, and a small still image
/// (about 640 pixels on the long side) for the server. The file itself never leaves the phone.
enum ClipLoader {
    /// The shared file, hard-linked (or copied) somewhere it stays while it's read.
    static func file(from provider: NSItemProvider, type: UTType) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url else {
                    continuation.resume(throwing: error ?? CocoaError(.fileNoSuchFile))
                    return
                }
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                let copy = dir.appendingPathComponent(url.lastPathComponent)
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    do {
                        try FileManager.default.linkItem(at: url, to: copy)
                    } catch {
                        try FileManager.default.copyItem(at: url, to: copy)
                    }
                    continuation.resume(returning: copy)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    static func video(at url: URL, name: String?) async throws -> PendingAttachment {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        var taken: Date?
        if let item = try await asset.load(.creationDate) {
            taken = (try? await item.load(.dateValue)) ?? nil
        }
        var size: CGSize?
        if let track = try await asset.loadTracks(withMediaType: .video).first {
            let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
            let box = CGRect(origin: .zero, size: natural).applying(transform)
            size = CGSize(width: abs(box.width), height: abs(box.height))
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)
        let at = CMTime(seconds: duration.isFinite ? min(1, max(0, duration / 2)) : 0, preferredTimescale: 600)
        let (image, _) = try await generator.image(at: at)
        guard let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.7) else { throw CocoaError(.fileReadCorruptFile) }
        return PendingAttachment(
            kind: "video",
            photosLocalId: nil,
            photosCloudId: nil,
            filename: filename(name, url),
            takenAt: taken,
            durationS: duration.isFinite ? duration : nil,
            width: size.map { Int($0.width.rounded()) },
            height: size.map { Int($0.height.rounded()) },
            thumb: jpeg
        )
    }

    static func photo(at url: URL, name: String?) throws -> PendingAttachment {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw CocoaError(.fileReadCorruptFile) }
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        var width = props[kCGImagePropertyPixelWidth] as? Int
        var height = props[kCGImagePropertyPixelHeight] as? Int
        if let orientation = props[kCGImagePropertyOrientation] as? UInt32, (5...8).contains(orientation) {
            swap(&width, &height)
        }
        let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let taken = exifDate(
            exif?[kCGImagePropertyExifDateTimeOriginal] as? String,
            offset: exif?[kCGImagePropertyExifOffsetTimeOriginal] as? String
        )
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 640,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let still = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let jpeg = UIImage(cgImage: still).jpegData(compressionQuality: 0.7)
        else { throw CocoaError(.fileReadCorruptFile) }
        return PendingAttachment(
            kind: "photo",
            photosLocalId: nil,
            photosCloudId: nil,
            filename: filename(name, url),
            takenAt: taken,
            durationS: nil,
            width: width,
            height: height,
            thumb: jpeg
        )
    }

    /// The original's name: the share sheet's suggested name ("IMG_1234") with the file's extension.
    static func filename(_ suggested: String?, _ url: URL) -> String {
        guard let suggested, !suggested.isEmpty else { return url.lastPathComponent }
        let ext = url.pathExtension
        return (suggested as NSString).pathExtension.isEmpty && !ext.isEmpty ? "\(suggested).\(ext)" : suggested
    }

    /// EXIF "2026:10:19 14:02:11" with its "-05:00" offset; the phone's time zone if the offset is missing.
    static func exifDate(_ value: String?, offset: String?, timeZone: TimeZone = .current) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        if let offset, !offset.isEmpty {
            f.dateFormat = "yyyy:MM:dd HH:mm:ssxxx"
            return f.date(from: value + offset)
        }
        f.timeZone = timeZone
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        return f.date(from: value)
    }
}
