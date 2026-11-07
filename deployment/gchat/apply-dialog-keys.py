# Keep this fixed program free of double quotes, backticks and dollar signs:
# deliver.sh sends its source as one double-quoted remote Python argument.
import json
import os
from pathlib import Path
import sys
import tempfile

try:
    path = Path(sys.argv[1])
    state = json.load(sys.stdin)
    original = path.read_text().splitlines()
    for line in original:
        if line.startswith('DIALOGS_ENCRYPTION_KEYS='):
            old = json.loads(line.split('=', 1)[1].strip().strip(chr(39)))
            if any(state['keys'].get(key) != value for key, value in old.items()):
                raise ValueError('Historical keys must be preserved')
    lines = [line for line in original if not line.startswith(('DIALOGS_ENCRYPTION_KEYS=', 'DIALOGS_ACTIVE_KEY_ID='))]
    quote = chr(39)
    lines += ['DIALOGS_ENCRYPTION_KEYS=' + quote + json.dumps(state['keys'], separators=(',', ':')) + quote,
              'DIALOGS_ACTIVE_KEY_ID=' + state['active']]
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write('\n'.join(lines) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, path.stat().st_mode & 0o777)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
except Exception:
    sys.exit('Dialog encryption configuration update failed')
