"""Increment the highest stable vMAJOR.MINOR.PATCH from repository tags/releases."""

import re
import sys


def next_version(names, bump):
    if bump not in {"major", "minor", "patch"}:
        raise ValueError("Version increment must be major, minor or patch")
    versions = [(0, 0, 0)]
    for name in names:
        match = re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", name.strip())
        if match:
            versions.append(tuple(int(part) for part in match.groups()))
    major, minor, patch = max(versions)
    if bump == "major":
        major, minor, patch = major + 1, 0, 0
    elif bump == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    return f"v{major}.{minor}.{patch}"


if __name__ == "__main__":
    try:
        print(next_version(sys.stdin, sys.argv[1]))
    except (ValueError, IndexError) as error:
        sys.exit(str(error))
