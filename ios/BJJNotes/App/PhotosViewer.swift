import AVKit
import Photos
import UIKit

/// Opens a note's photo or video from the Photos library: the original, at full quality, downloaded
/// from iCloud if this phone only has a preview.
@MainActor
enum PhotosViewer {
    static func open(localId: String?, cloudId: String?, from presenter: UIViewController) async {
        if PhotosLibrary.notAskedYet { await PhotosLibrary.requestAccess() }
        guard PhotosLibrary.canRead else {
            return tell(presenter, "BJJ Notes can't see your Photos", "Allow it in Settings → Apps → BJJ Notes → Photos, then try again.")
        }
        guard localId != nil || cloudId != nil else {
            return tell(presenter, "Not found in Photos yet", "BJJ Notes looks for it again each time you open the app.")
        }
        guard let asset = PhotosLibrary.asset(localId: localId, cloudId: cloudId) else {
            return tell(presenter, "Not in your Photos", "This one isn't in your Photos library anymore.")
        }
        if asset.mediaType == .video {
            await playVideo(asset, from: presenter)
        } else {
            await showPhoto(asset, from: presenter)
        }
    }

    private static func playVideo(_ asset: PHAsset, from presenter: UIViewController) async {
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        let item: AVPlayerItem? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
                continuation.resume(returning: item)
            }
        }
        guard let item else {
            return tell(presenter, "Couldn't play it", "Photos couldn't load this video. If it's only in iCloud, check your connection.")
        }
        let player = AVPlayerViewController()
        player.player = AVPlayer(playerItem: item)
        presenter.present(player, animated: true) { player.player?.play() }
    }

    private static func showPhoto(_ asset: PHAsset, from presenter: UIViewController) async {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        let scale = presenter.traitCollection.displayScale
        let bounds = presenter.view.bounds.size
        let target = CGSize(width: bounds.width * scale * 2, height: bounds.height * scale * 2)
        let image: UIImage? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(for: asset, targetSize: target, contentMode: .aspectFit, options: options) { image, _ in
                continuation.resume(returning: image)
            }
        }
        guard let image else {
            return tell(presenter, "Couldn't open it", "Photos couldn't load this photo. If it's only in iCloud, check your connection.")
        }
        let viewer = PhotoViewController(image: image)
        viewer.modalPresentationStyle = .fullScreen
        presenter.present(viewer, animated: true)
    }

    private static func tell(_ presenter: UIViewController, _ title: String, _ message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: true)
    }
}

/// A photo, full screen: pinch to zoom, tap Done to close.
final class PhotoViewController: UIViewController, UIScrollViewDelegate {
    private let imageView: UIImageView
    private let scroll = UIScrollView()

    init(image: UIImage) {
        imageView = UIImageView(image: image)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scroll.frame = view.bounds
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        imageView.contentMode = .scaleAspectFit
        imageView.frame = scroll.bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(imageView)
        view.addSubview(scroll)

        var config = UIButton.Configuration.filled()
        config.title = "Done"
        config.baseBackgroundColor = UIColor.black.withAlphaComponent(0.5)
        config.cornerStyle = .capsule
        let done = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        done.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(done)
        NSLayoutConstraint.activate([
            done.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            done.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
        ])
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
}
