#!/usr/bin/env python3
"""Build the pinned official WebRTC SDK; never substitute a third-party binary."""

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

DIRECTORY = Path(__file__).resolve().parent
LOCK = json.loads((DIRECTORY / "build-lock.json").read_text())


def run(command, cwd, environment, reserve):
    if shutil.disk_usage(cwd).free < reserve:
        raise RuntimeError("Insufficient free space; no files were deleted")
    print("+", " ".join(map(str, command)), flush=True)
    process = subprocess.Popen(command, cwd=cwd, env=environment, start_new_session=True)
    try:
        while process.poll() is None:
            if shutil.disk_usage(cwd).free < reserve:
                raise RuntimeError("Free space reserve reached; build stopped without deleting files")
            time.sleep(2)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def output(command, cwd=None):
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def checkout(path, url, revision, environment, reserve):
    path.mkdir(parents=True, exist_ok=True)
    if not (path / ".git").exists():
        if any(path.iterdir()):
            raise RuntimeError(f"Refusing to initialize nonempty directory: {path}")
        run(["git", "init", "--quiet", str(path)], path, environment, reserve)
        run(["git", "remote", "add", "origin", url], path, environment, reserve)
    if output(["git", "remote", "get-url", "origin"], path) != url:
        raise RuntimeError(f"Unexpected repository origin: {path}")
    if output(["git", "status", "--porcelain", "--untracked-files=no"], path):
        raise RuntimeError(f"Refusing to use a checkout with local modifications: {path}")
    current = subprocess.run(["git", "rev-parse", "HEAD"], cwd=path, capture_output=True, text=True)
    if current.returncode == 0 and current.stdout.strip() == revision:
        return
    run(["git", "fetch", "--depth", "1", "origin", revision], path, environment, reserve)
    run(["git", "checkout", "--detach", revision], path, environment, reserve)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--depot-tools", type=Path, required=True)
    parser.add_argument("--stage", choices=["prepare", "sync", "hooks", "build", "package"], required=True)
    parser.add_argument("--reserve-gib", type=int, default=8)
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise RuntimeError("The iOS SDK must be built on macOS")
    xcode = output(["xcodebuild", "-version"])
    if xcode.splitlines() != [LOCK["xcode_version"], "Build version " + LOCK["xcode_build"]]:
        raise RuntimeError("Xcode differs from build-lock.json; review the toolchain pin first")
    if args.reserve_gib < 1:
        raise RuntimeError("Reserve must be at least 1 GiB")
    reserve = args.reserve_gib * 1024**3
    work = args.work_dir.resolve()
    depot = args.depot_tools.resolve()
    work.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, DEPOT_TOOLS_UPDATE="0")
    environment["PATH"] = str(depot) + os.pathsep + environment["PATH"]
    src = work / "src"
    if args.stage == "prepare":
        checkout(depot, LOCK["depot_tools_upstream"], LOCK["depot_tools_revision"], environment, reserve)
        checkout(src, LOCK["upstream"], LOCK["revision"], environment, reserve)
        # This pin has exactly one unnamed hook: the upstream test-media download.
        # Verify that assumption before suppressing it through gclient's public config.
        tree = ast.parse((src / "DEPS").read_text())
        unnamed = []
        for item in tree.body:
            if isinstance(item, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "hooks" for t in item.targets):
                for hook in item.value.elts:
                    properties = dict(zip([k.value for k in hook.keys], hook.values))
                    if "name" not in properties:
                        unnamed.append(ast.literal_eval(properties["action"]))
        expected = [["download_from_google_storage", "--directory", "--recursive", "--num_threads=10", "--quiet", "--bucket", "chromium-webrtc-resources", "src/resources"]]
        if unnamed != expected:
            raise RuntimeError("Unexpected unnamed upstream hooks; review before suppressing test resources")
        config = (
            "solutions = [{'name': 'src', 'url': " + repr(LOCK["upstream"]) +
            ", 'managed': False, 'deps_file': 'DEPS', 'custom_deps': {}, 'custom_vars': {}}]\n"
            "target_os = ['ios', 'mac']\n"
        )
        previous_config = config
        config = config.replace("'custom_vars': {}", "'custom_vars': {}, 'custom_hooks': [{'name': ''}]")
        path = work / ".gclient"
        if path.exists() and path.read_text() not in [config, previous_config]:
            raise RuntimeError("Existing .gclient differs; refusing to overwrite it")
        path.write_text(config)
        return
    for path, revision in [(src, LOCK["revision"]), (depot, LOCK["depot_tools_revision"])]:
        if output(["git", "rev-parse", "HEAD"], path) != revision:
            raise RuntimeError(f"Unexpected source revision: {path}")
        if output(["git", "status", "--porcelain", "--untracked-files=no"], path):
            raise RuntimeError(f"Refusing to build a checkout with local modifications: {path}")
    if args.stage == "sync":
        run([str(depot / "gclient"), "sync", "--no-history", "--shallow", "--nohooks",
             "--revision", "src@" + LOCK["revision"], "--jobs", "4"], work, environment, reserve)
    elif args.stage == "hooks":
        run([str(depot / "gclient"), "runhooks"], work, environment, reserve)
    elif args.stage == "build":
        run([str(depot / "vpython3"), str(src / "tools_webrtc/ios/build_ios_libs.py"),
             "--build_config", LOCK["configuration"], "--arch", *LOCK["architectures"],
             "--deployment-target", LOCK["deployment_target"],
             "--output-dir", str(src / "out_gchat_ios"),
             "--extra-gn-args", *LOCK["extra_gn_args"]], src, environment, reserve)
    elif args.stage == "package":
        framework = src / "out_gchat_ios/WebRTC.xcframework"
        if not (framework / "Info.plist").is_file():
            raise RuntimeError("XCFramework is missing; no placeholder artifact will be produced")
        if not (framework / "LICENSE.md").is_file():
            raise RuntimeError("Upstream license output is missing; refusing to package the SDK")
        info = json.loads(output(["plutil", "-convert", "json", "-o", "-", str(framework / "Info.plist")]))
        variants = {(v["SupportedPlatform"], v.get("SupportedPlatformVariant", ""), tuple(v["SupportedArchitectures"])) for v in info["AvailableLibraries"]}
        if variants != {("ios", "", ("arm64",)), ("ios", "simulator", ("arm64",))}:
            raise RuntimeError("XCFramework slices differ from the accepted build scope")
        archive = work / ("WebRTC-" + LOCK["revision"][:12] + ".xcframework.zip")
        if archive.exists():
            raise RuntimeError("Archive exists; preserve it or choose another work directory")
        run(["ditto", "-c", "-k", "--keepParent", str(framework), str(archive)], work, environment, reserve)
        with archive.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        result = {**LOCK, "artifact": str(archive), "artifact_sha256": digest, "status": "built_not_accepted"}
        (work / "build-result.json").write_text(json.dumps(result, indent=2) + "\n")
        print("Artifact SHA-256:", digest)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Build stopped: {error}", file=sys.stderr)
        sys.exit(1)
