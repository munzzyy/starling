import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    // The screen holds a live map of the circle, and the app switcher would
    // otherwise thumbnail it. Android sets FLAG_SECURE unconditionally; here
    // a shield covers the window whenever the app leaves the foreground, for
    // everybody, unconditionally, for the same reason.
    private let shield = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterialDark))

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        excludeWebKitStoreFromBackup()
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    // The circle secret lives in IndexedDB under Library/WebKit, which iCloud
    // and device backups would otherwise carry to Apple's servers, readable
    // there without Advanced Data Protection. Android ships
    // allowBackup="false" for the same secret; this is that, for iOS. The
    // directory is created first so the mark exists before WebKit's first
    // write, and a failure leaves nothing worse than the default.
    private func excludeWebKitStoreFromBackup() {
        guard let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
        else { return }
        var webkit = library.appendingPathComponent("WebKit", isDirectory: true)
        try? FileManager.default.createDirectory(at: webkit, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? webkit.setResourceValues(values)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        guard let window, shield.superview == nil else { return }
        shield.frame = window.bounds
        shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(shield)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        shield.removeFromSuperview()
    }
}
