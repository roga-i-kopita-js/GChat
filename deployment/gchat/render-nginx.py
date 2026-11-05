"""Render only known placeholders; preserve nginx variables verbatim."""

import pathlib
import re
import sys


def render(template, domain, port):
    if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?", domain):
        raise ValueError("Invalid domain")
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("Invalid backend port")
    return template.replace("${GCHAT_DOMAIN}", domain).replace("${GCHAT_HTTP_PORT}", port)


if __name__ == "__main__":
    source, destination, domain, port = sys.argv[1:]
    pathlib.Path(destination).write_text(render(pathlib.Path(source).read_text(), domain, port))
