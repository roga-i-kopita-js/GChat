import hashlib
import json
import os
import pathlib
import runpy
import shutil
import subprocess
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1]
VERIFY = runpy.run_path(str(SOURCE / "verify-release.py"))
RENDER = runpy.run_path(str(SOURCE / "render-nginx.py"))["render"]
SHA = "a" * 40
RELEASE_ID = SHA + "-123-1"
IMAGE_ID = "sha256:" + "b" * 64


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gchat-deploy-test-")
        self.root = pathlib.Path(self.temp.name)
        self.release = self.root / "incoming" / RELEASE_ID
        self.release.mkdir(parents=True)
        for name in VERIFY["FILES"] - {"release.json", "gchat-image.tar.gz"}:
            shutil.copyfile(SOURCE / name, self.release / name)
        (self.release / "gchat-image.tar.gz").write_bytes(b"test image")
        self.manifest = {
            "formatVersion": 1, "releaseId": RELEASE_ID, "sourceSha": SHA,
            "version": "v0.1.0", "runId": "123", "runAttempt": "1",
            "image": "gchat:" + RELEASE_ID, "imageId": IMAGE_ID, "platform": "linux/amd64",
        }
        self.save_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def checksums(self):
        lines = []
        for name in sorted(VERIFY["FILES"]):
            digest = hashlib.sha256((self.release / name).read_bytes()).hexdigest()
            lines.append(f"{digest}  {name}\n")
        (self.release / "SHA256SUMS").write_text("".join(lines))

    def save_manifest(self):
        (self.release / "release.json").write_text(json.dumps(self.manifest))
        self.checksums()

    def test_complete_release(self):
        self.assertEqual(VERIFY["verify"](self.release), self.manifest)

    def test_selected_version_must_match_manifest(self):
        self.assertEqual(VERIFY["verify"](self.release, "v0.1.0"), self.manifest)
        with self.assertRaises(ValueError):
            VERIFY["verify"](self.release, "v0.2.0")

    def test_delivery_reuses_bundle_and_does_not_return_stale_success(self):
        # Exercise delivery against a local fake SSH transport; no real host or keys.
        (self.release / "deploy.sh").write_text('''#!/usr/bin/env bash
echo attempt >> "$1/attempts"
if [[ -f "$1/fail" ]]; then
  echo 'failed stage=test' > "$2/result"
else
  echo success > "$2/result"
fi
''')
        self.checksums()
        work = self.root / "actions"
        work.mkdir()
        shutil.copytree(self.release, work / "release")
        server = self.root / "server"
        server.mkdir()
        tools = self.root / "transport"
        tools.mkdir()
        mocks = {
            "ssh": '''
while [[ "$1" == -* ]]; do shift 2; done
shift
exec bash -c "$1"
''',
            "scp": '''
while [[ "$1" == -* ]]; do shift 2; done
args=("$@")
destination=${args[${#args[@]}-1]#*:}
for ((i=0; i<${#args[@]}-1; i++)); do cp "${args[i]}" "$destination"; done
''',
            "flock": 'shift 2; exec "$@"',
            "sleep": '/bin/sleep 0.02',
        }
        for name, content in mocks.items():
            path = tools / name
            path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + content + "\n")
            path.chmod(0o755)
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"],
                   SSH_HOST="test.invalid", SSH_PORT="22", SSH_USER="deploy",
                   SSH_KEY="fake-key", SSH_KNOWN_HOSTS="fake-host-key", INSTALL_ROOT=str(server))
        command = ["bash", str(SOURCE / "deliver.sh")]
        first = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(first.returncode, 0, first.stderr)
        (server / "fail").touch()
        second = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("failed stage=test", second.stdout)
        self.assertEqual((server / "attempts").read_text().splitlines(), ["attempt", "attempt"])
        self.assertTrue((server / "incoming" / RELEASE_ID / "release.json").is_file())

    def test_corrupt_or_partial_transfer(self):
        (self.release / "gchat-image.tar.gz").write_bytes(b"truncated")
        with self.assertRaises(ValueError):
            VERIFY["verify"](self.release)
        (self.release / "compose.yaml").unlink()
        with self.assertRaises((ValueError, OSError)):
            VERIFY["verify"](self.release)

    def test_rejects_checksum_paths_and_symlinks(self):
        with (self.release / "SHA256SUMS").open("a") as out:
            out.write("0" * 64 + "  ../secret\n")
        with self.assertRaises(ValueError):
            VERIFY["verify"](self.release)
        self.checksums()
        (self.release / "compose.yaml").unlink()
        (self.release / "compose.yaml").symlink_to(SOURCE / "compose.yaml")
        with self.assertRaises(ValueError):
            VERIFY["verify"](self.release)

    def test_rejects_image_identity_mismatch(self):
        self.manifest["image"] = "gchat:" + "c" * 40 + "-123-1"
        self.save_manifest()
        with self.assertRaises(ValueError):
            VERIFY["verify"](self.release)

    def test_nginx_render_preserves_variables_and_rejects_injection(self):
        template = (SOURCE / "nginx.conf.template").read_text()
        rendered = RENDER(template, "chat.example.com", "3000")
        self.assertIn("$http_origin", rendered)
        self.assertIn("$request_uri", rendered)
        self.assertNotIn("${GCHAT_", rendered)
        for domain, port in [("host; include evil", "3000"), ("ok.com", "65536")]:
            with self.assertRaises(ValueError):
                RENDER(template, domain, port)

    def run_deploy(self, failure=""):
        shared = self.root / "shared"
        (shared / "secrets").mkdir(parents=True, exist_ok=True)
        (shared / "secrets/apns.p8").write_text("test")
        (shared / "backend.env").write_text("# test configuration\n")
        (shared / "turnserver.conf").write_text("# test configuration\n")
        (shared / "compose.env").write_text(
            "GCHAT_DOMAIN=chat.example.com\nGCHAT_HTTP_PORT=3000\nGCHAT_READY_TIMEOUT=120\n"
        )
        tools = self.root / "bin"
        tools.mkdir(exist_ok=True)
        mocks = {
            "flock": '[[ "$FAILURE" != lock ]]',
            "df": 'printf "Filesystem blocks used available capacity mounted\\nmock 99999999 0 99999999 0 /\\n"',
            "sudo": '''
echo "sudo $*" >> "$TRACE"
[[ "$*" != *"test -f"* ]] || exit 1
if [[ "$*" == *"nginx -t"* && "$FAILURE" == nginx ]]; then exit 1; fi
if [[ "$*" == *"systemctl reload"* && "$FAILURE" == reload ]]; then exit 1; fi
exit 0
''',
            "mv": '''
if [[ "$1" == -Tf ]]; then
  python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$2" "$3"
else
  /bin/mv "$@"
fi
''',
            "curl": '''
echo "curl $*" >> "$TRACE"
[[ "$FAILURE" != https ]] || exit 1
if [[ "$*" == *"--write-out"* ]]; then printf 404; exit 0; fi
while (( $# )); do
  if [[ "$1" == -o ]]; then
    printf '<html><script src="/apps/static/test.js"></script></html>' > "$2"
    break
  fi
  shift
done
exit 0
''',
            "docker": '''
echo "docker $*" >> "$TRACE"
case "$*" in
  "version "*) echo amd64 ;;
  "image inspect "*)
    if [[ "$*" == *".Id"* ]]; then echo "$TEST_IMAGE_ID"; else echo linux/amd64; fi ;;
  *"config --quiet"*) [[ "$FAILURE" != config ]] ;;
  *"pg_dump"*) [[ "$FAILURE" != backup ]] && echo backup ;;
  *"run --rm --no-deps migrate"*) [[ "$FAILURE" != migrate ]] ;;
  *"up -d --no-deps --wait"*) [[ "$FAILURE" != ready ]] ;;
  *) exit 0 ;;
esac
''',
        }
        for name, content in mocks.items():
            path = tools / name
            path.write_text("#!/usr/bin/env bash\n" + content + "\n")
            path.chmod(0o755)
        trace = self.root / "trace"
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"],
                   TRACE=str(trace), FAILURE=failure, TEST_IMAGE_ID=IMAGE_ID)
        result = subprocess.run(
            ["bash", str(self.release / "deploy.sh"), str(self.root), str(self.release)],
            env=env, capture_output=True, text=True, timeout=15,
        )
        return result, trace.read_text() if trace.exists() else ""

    def test_checksum_failure_does_not_touch_docker(self):
        (self.release / "gchat-image.tar.gz").write_bytes(b"broken")
        result, trace = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(trace, "")

    def test_missing_server_configuration_is_reported_before_docker(self):
        shared = self.root / "shared"
        shared.mkdir()
        result = subprocess.run(
            ["bash", str(self.release / "deploy.sh"), str(self.root), str(self.release)],
            capture_output=True, text=True, timeout=15,
            env=dict(os.environ, PATH=str(self.create_lock_stub()) + os.pathsep + os.environ["PATH"]),
        )
        self.assertNotEqual(result.returncode, 0)
        for file in ["compose.env", "backend.env", "turnserver.conf"]:
            self.assertIn(str(shared / file), result.stderr)
        self.assertIn("failed stage=config", (self.release / "result").read_text())

    def create_lock_stub(self):
        tools = self.root / "bin"
        tools.mkdir()
        flock = tools / "flock"
        flock.write_text("#!/usr/bin/env bash\nexit 0\n")
        flock.chmod(0o755)
        return tools

    def test_lock_refusal_does_not_start_migrator(self):
        result, trace = self.run_deploy("lock")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("migrate", trace)

    def test_preflight_failure_leaves_app_running(self):
        result, trace = self.run_deploy("nginx")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("stop app", trace)
        self.assertNotIn("run --rm --no-deps migrate", trace)

    def test_backup_failure_leaves_app_running(self):
        result, trace = self.run_deploy("backup")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("stop app", trace)

    def test_migration_failure_does_not_start_new_app_or_record_release(self):
        result, trace = self.run_deploy("migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stop app", trace)
        self.assertNotIn("up -d", trace)
        self.assertFalse((self.root / "current").exists())
        self.assertIn("failed stage=migrate", (self.release / "result").read_text())

    def test_readiness_failure_does_not_record_release(self):
        result, trace = self.run_deploy("ready")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run --rm --no-deps migrate", trace)
        self.assertFalse((self.root / "current").exists())
        self.assertIn("failed stage=start", (self.release / "result").read_text())

    def test_success_and_repeat_preserve_previous_and_skip_migrations(self):
        previous = self.root / "incoming" / "older-release"
        previous.mkdir()
        (self.root / "current").symlink_to(previous)
        result, trace = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "current").resolve(), self.release.resolve())
        self.assertEqual((self.root / "previous").resolve(), previous.resolve())
        self.assertEqual((self.release / "result").read_text(), "success\n")
        (self.root / "trace").unlink()
        result, trace = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("stop app", trace)
        self.assertNotIn("run --rm --no-deps migrate", trace)
        self.assertEqual((self.root / "previous").resolve(), previous.resolve())

    def test_https_failure_restores_nginx_without_recording_release(self):
        result, trace = self.run_deploy("https")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rm -f /etc/nginx/conf.d/gchat.conf", trace)
        self.assertFalse((self.root / "current").exists())
        self.assertIn("failed stage=https", (self.release / "result").read_text())

    def test_nginx_reload_failure_does_not_record_release(self):
        result, trace = self.run_deploy("reload")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "current").exists())
        self.assertIn("failed stage=nginx", (self.release / "result").read_text())


if __name__ == "__main__":
    unittest.main()
