import base64
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent


class DialogKeyDelivery(unittest.TestCase):
    def test_validation_does_not_print_invalid_secrets(self):
        result = subprocess.run(
            ['python3', str(ROOT / 'prepare-dialog-keys.py')],
            env={**os.environ, 'DIALOGS_ACTIVE_KEY_ID': 'one', 'DIALOGS_ENCRYPTION_KEYS': 'secret-invalid'},
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('secret-invalid', result.stderr)

    def test_remote_shell_quoting_preserves_newlines_and_historical_keys(self):
        code = (ROOT / 'apply-dialog-keys.py').read_text()
        for unsafe in ['"', '$', '`']:
            self.assertNotIn(unsafe, code)
        old = base64.b64encode(bytes(range(32))).decode()
        new = base64.b64encode(bytes(range(32, 64))).decode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'backend.env'
            original = "DATABASE_URL='postgresql://example.invalid/db'\nDIALOGS_ENCRYPTION_KEYS='" + json.dumps({'one': old}) + "'\nDIALOGS_ACTIVE_KEY_ID=one\n"
            path.write_text(original)
            path.chmod(0o600)
            command = 'python3 -c "' + code + '" ' + shlex.quote(str(path))
            def apply(keys):
                return subprocess.run(['sh', '-c', command], input=json.dumps({'keys': keys, 'active': 'two'}), text=True, capture_output=True)
            result = apply({'one': old, 'two': new})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '')
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 3)
            self.assertEqual(lines[0], original.splitlines()[0])
            self.assertEqual(lines[-1], 'DIALOGS_ACTIVE_KEY_ID=two')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            preserved = path.read_text()
            for keys in [{'two': new}, {'one': new, 'two': old}]:
                rejected = apply(keys)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(path.read_text(), preserved)
                self.assertNotIn(old, rejected.stderr)


if __name__ == '__main__':
    unittest.main()
