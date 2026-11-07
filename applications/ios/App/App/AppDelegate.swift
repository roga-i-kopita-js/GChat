import UIKit
import UserNotifications
import GChatCore

extension Notification.Name {
    static let gchatDialogIntent = Notification.Name("gchat.dialog-intent")
}

@MainActor enum ChatLocalStorage {
    private static var stores: [String: DialogStorage] = [:]
    static func forServer(_ server: ServerOrigin) throws -> DialogStorage {
        let key = server.url.absoluteString
        if let value = stores[key] { return value }
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let value = try DialogStorage(url: root.appendingPathComponent("GChat/dialogs.sqlite"), server: key)
        stores[key] = value
        return value
    }
}

@MainActor final class ChatNotifications {
    static let shared = ChatNotifications()
    private(set) var delivery = "unavailable"
    private var token: String?
    private weak var transport: SharedWebSocket?
    private var generation = 0
    private var pending: String?
    var openDialog: String?
    var visibleDialog: (() -> String?)?
    private let enabledKey = "gchat.chat-notifications.enabled"
    private var enabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    func attach(_ transport: SharedWebSocket) {
        self.transport = transport
        generation += 1
        delivery = enabled ? "enabling" : "disabled"
    }
    func connectionChanged() {
        generation += 1
        let revision = generation
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard revision == generation else { return }
            if enabled && [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) {
                UIApplication.shared.registerForRemoteNotifications()
                await register(revision)
            } else { delivery = enabled ? "unavailable" : "disabled" }
        }
    }
    func receivedToken(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        let revision = generation
        Task { @MainActor in await register(revision) }
    }
    func failed() { delivery = "error" }
    private func register(_ revision: Int) async {
        guard enabled, let token, let transport, transport.status == "online" else { return }
        delivery = "enabling"
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        do {
            _ = try await transport.request("device.apns_token", payload: ["token": token, "environment": environment], publish: false)
            if revision == generation && enabled { delivery = "enabled" }
        } catch { if revision == generation { delivery = "error" } }
    }
    func setEnabled(_ value: Bool) async throws {
        generation += 1
        if value {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            UserDefaults.standard.set(true, forKey: enabledKey)
            delivery = "enabling"
            connectionChanged()
        } else {
            guard let transport, transport.status == "online" else { throw DeviceCommandError("DEVICE_UNAVAILABLE") }
            #if DEBUG
            let environment = "sandbox"
            #else
            let environment = "production"
            #endif
            _ = try await transport.request("device.apns_token", payload: ["token": NSNull(), "environment": environment], publish: false)
            UserDefaults.standard.set(false, forKey: enabledKey)
            UIApplication.shared.unregisterForRemoteNotifications()
            delivery = "disabled"
        }
    }
    func intent(_ info: [AnyHashable: Any]) {
        guard info["type"] as? String == "dialog.message", let id = info["dialog_id"] as? String, UUID(uuidString: id) != nil else { return }
        pending = id
        NotificationCenter.default.post(name: .gchatDialogIntent, object: nil, userInfo: ["dialogId": id])
    }
    func takePending() -> String? { defer { pending = nil }; return pending }
    func clearIntent() { pending = nil; openDialog = nil }
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        ChatNotifications.shared.receivedToken(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        ChatNotifications.shared.failed()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            ChatNotifications.shared.intent(response.notification.request.content.userInfo)
            completionHandler()
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            let info = notification.request.content.userInfo
            if info["type"] as? String == "dialog.message", info["dialog_id"] as? String == ChatNotifications.shared.visibleDialog?() { completionHandler([]) }
            else { completionHandler([.banner, .sound]) }
        }
    }
}
