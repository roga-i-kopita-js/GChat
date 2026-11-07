// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GChatCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "GChatCore", targets: ["GChatCore"])],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .target(name: "GChatCore", dependencies: ["CSQLite"]),
        .testTarget(name: "GChatCoreTests", dependencies: ["GChatCore"])
    ]
)
