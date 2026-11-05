"""Validate a complete release before loading its image or invoking its tools."""

import hashlib
import json
import pathlib
import re
import sys

FILES = {
    "gchat-image.tar.gz", "compose.yaml", "nginx.conf.template", "deploy.sh",
    "render-nginx.py", "verify-release.py", "release.json",
}


def verify(directory, expected_version=None):
    directory = pathlib.Path(directory)
    entries = {}
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)", line)
        if not match or match[2] in entries:
            raise ValueError("Invalid checksum list")
        entries[match[2]] = match[1]
    if set(entries) != FILES:
        raise ValueError("Incomplete release")
    for name, expected in entries.items():
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Invalid release file")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("Checksum mismatch: " + name)
    manifest = json.loads((directory / "release.json").read_text())
    if manifest["formatVersion"] != 1:
        raise ValueError("Unsupported release format")
    if expected_version is not None and manifest["version"] != expected_version:
        raise ValueError("Selected version does not match release manifest")
    for field, pattern in {
        "releaseId": r"[a-f0-9]{40}-[0-9]+-[0-9]+",
        "sourceSha": r"[a-f0-9]{40}",
        "version": r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?",
        "image": r"gchat:[a-f0-9]{40}-[0-9]+-[0-9]+",
        "imageId": r"sha256:[a-f0-9]{64}",
        "platform": r"linux/(amd64|arm64)",
    }.items():
        if not re.fullmatch(pattern, str(manifest[field])):
            raise ValueError("Invalid manifest field: " + field)
    if manifest["image"] != "gchat:" + manifest["releaseId"]:
        raise ValueError("Image/release mismatch")
    if manifest["releaseId"] != f'{manifest["sourceSha"]}-{manifest["runId"]}-{manifest["runAttempt"]}':
        raise ValueError("Build/release mismatch")
    return manifest


if __name__ == "__main__":
    try:
        manifest = verify(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
        print(manifest["releaseId"], manifest["image"], manifest["imageId"], manifest["platform"])
    except (ValueError, KeyError, OSError):
        sys.exit("Release verification failed")
