// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GChatCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "GChatCore", targets: ["GChatCore"])],
    targets: [
        .target(name: "GChatCore"),
        .testTarget(name: "GChatCoreTests", dependencies: ["GChatCore"])
    ]
)
