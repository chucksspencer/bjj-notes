import Foundation
import Photos

/// What's known about a shared photo or video, used to find the original in Photos.
struct ClipFacts: Equatable {
    let isVideo: Bool
    let filename: String?
    let takenAt: Date?
    let duration: Double?

    /// "IMG_1234" from "IMG_1234.MOV", upper-cased, for comparing names.
    static func stem(_ name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        return (name as NSString).deletingPathExtension.uppercased()
    }
}

/**
 Which library item a shared file is. iOS hands a share extension a copy of the file, not the item, so
 the original is found by what the copy carries: its name (IMG_1234), when it was taken and, for videos,
 how long it is. A match needs more than one weak hint, and anything taken at a clearly different time
 is ruled out, so a reused name can't pick the wrong clip.
 */
enum PhotosMatch {
    static func best(for target: ClipFacts, among candidates: [ClipFacts]) -> Int? {
        var bestIndex: Int?
        var bestScore = 0
        for (i, c) in candidates.enumerated() where c.isVideo == target.isVideo {
            var score = 0
            if let a = target.takenAt, let b = c.takenAt {
                let gap = abs(a.timeIntervalSince(b))
                if gap > 60 { continue }
                if gap <= 1.5 { score += 2 } else if gap <= 3 { score += 1 }
            }
            if let a = ClipFacts.stem(target.filename), let b = ClipFacts.stem(c.filename), a == b { score += 2 }
            if target.isVideo, let a = target.duration, let b = c.duration, abs(a - b) <= 0.6 { score += 1 }
            if score > bestScore {
                bestScore = score
                bestIndex = i
            }
        }
        return bestScore >= 2 ? bestIndex : nil
    }
}

/// The Photos library: permission, finding a shared item's original, and opening a saved reference.
enum PhotosLibrary {
    static var canRead: Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return status == .authorized || status == .limited
    }

    static var notAskedYet: Bool {
        PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined
    }

    @discardableResult
    static func requestAccess() async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return status == .authorized || status == .limited
    }

    /// The original of a shared photo or video: this phone's id for it and its iCloud Photos id.
    static func find(_ facts: ClipFacts) -> (local: String, cloud: String?)? {
        guard canRead else { return nil }
        let options = PHFetchOptions()
        let type = facts.isVideo ? PHAssetMediaType.video : PHAssetMediaType.image
        var predicates = [NSPredicate(format: "mediaType == %d", type.rawValue)]
        if let taken = facts.takenAt {
            predicates.append(NSPredicate(
                format: "creationDate >= %@ AND creationDate <= %@",
                taken.addingTimeInterval(-3) as NSDate,
                taken.addingTimeInterval(3) as NSDate
            ))
            options.fetchLimit = 25
        } else {
            // No date on the copy: look for the name among the most recent items.
            options.fetchLimit = 400
        }
        options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        var assets: [PHAsset] = []
        var candidates: [ClipFacts] = []
        PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in
            assets.append(asset)
            candidates.append(ClipFacts(
                isVideo: asset.mediaType == .video,
                filename: PHAssetResource.assetResources(for: asset).first?.originalFilename,
                takenAt: asset.creationDate,
                duration: asset.mediaType == .video ? asset.duration : nil
            ))
        }
        guard let i = PhotosMatch.best(for: facts, among: candidates) else { return nil }
        let local = assets[i].localIdentifier
        return (local, cloudID(for: local))
    }

    static func cloudID(for localId: String) -> String? {
        if case .success(let cloud)? = PHPhotoLibrary.shared().cloudIdentifierMappings(forLocalIdentifiers: [localId])[localId] {
            return cloud.stringValue
        }
        return nil
    }

    /// The item a saved reference points at: this phone's id first, then the iCloud Photos one.
    static func asset(localId: String?, cloudId: String?) -> PHAsset? {
        if let localId, let asset = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil).firstObject {
            return asset
        }
        if let cloudId {
            let cloud = PHCloudIdentifier(stringValue: cloudId)
            if case .success(let local)? = PHPhotoLibrary.shared().localIdentifierMappings(for: [cloud])[cloud] {
                return PHAsset.fetchAssets(withLocalIdentifiers: [local], options: nil).firstObject
            }
        }
        return nil
    }

    /// Fills in where each photo or video's original is, for those not found yet.
    static func link(_ note: PendingNote) -> PendingNote {
        guard canRead, var attachments = note.attachments, attachments.contains(where: { $0.photosLocalId == nil }) else { return note }
        for i in attachments.indices where attachments[i].photosLocalId == nil {
            if let found = find(attachments[i].facts) {
                attachments[i].photosLocalId = found.local
                attachments[i].photosCloudId = found.cloud
            }
        }
        var linked = note
        linked.attachments = attachments
        return linked
    }
}
