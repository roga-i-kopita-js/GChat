"""Validate Actions secrets and produce a temporary stdin payload without logging secrets."""
import base64
import json
import os
import re
import sys

try:
    keys = json.loads(os.environ["DIALOGS_ENCRYPTION_KEYS"])
    active = os.environ["DIALOGS_ACTIVE_KEY_ID"]
    assert isinstance(keys, dict) and active in keys and keys
    values = set()
    for key_id, encoded in keys.items():
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key_id)
        decoded = base64.b64decode(encoded, validate=True)
        assert len(decoded) == 32 and base64.b64encode(decoded).decode() == encoded
        assert encoded not in values
        values.add(encoded)
    json.dump({"keys": keys, "active": active}, sys.stdout)
except Exception:
    sys.exit("Invalid dialog encryption configuration")
