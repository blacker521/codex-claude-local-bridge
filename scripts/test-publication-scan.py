"""Integration checks for the publication gate, using only synthetic data."""

import io
import pathlib
import random
import shutil
import string
import subprocess
import sys
import tempfile
import unittest
import zipfile

SOURCE = pathlib.Path(__file__).resolve().parent.parent
generator = random.Random(5162703)
SYNTHETIC = "ghp_" + "".join(generator.choice(string.ascii_letters + string.digits) for _ in range(36))


class PublicationGate(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bridge-scan-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name) / "repository"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copyfile(str(SOURCE / "scripts/scan-publication.py"), str(self.root / "scripts/scan-publication.py"))
        shutil.copyfile(str(SOURCE / ".gitleaks.toml"), str(self.root / ".gitleaks.toml"))

    def scan(self, root=None):
        result = subprocess.run([sys.executable, "scripts/scan-publication.py"], cwd=str(root or self.root), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotIn(SYNTHETIC.encode(), result.stdout + result.stderr)
        return result

    def rejected_secret(self, result):
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"leaks found", result.stdout + result.stderr)

    def test_clean_directory(self):
        self.assertEqual(self.scan().returncode, 0)

    def test_sensitive_filename(self):
        (self.root / "auth.json").write_text("{}")
        result = self.scan()
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"sensitive filename", result.stderr)

    def test_personal_path_is_not_printed(self):
        private_path = "/" + "Users" + "/" + "private-test-user"
        (self.root / "example.txt").write_text(private_path)
        result = self.scan()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(private_path.encode(), result.stdout + result.stderr)

    def test_plain_synthetic_secret(self):
        (self.root / "fixture.txt").write_text('github_token = "' + SYNTHETIC + '"\n')
        self.rejected_secret(self.scan())

    def test_nested_zip_and_vsix_synthetic_secret(self):
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as archive:
            archive.writestr("extension/fixture.txt", 'github_token = "' + SYNTHETIC + '"\n')
        with zipfile.ZipFile(str(self.root / "fixture.zip"), "w") as archive:
            archive.writestr("fixture.vsix", inner.getvalue())
        self.rejected_secret(self.scan())

    def test_bundle_installer_and_embedded_helper_synthetic_secret(self):
        helper = io.BytesIO()
        with zipfile.ZipFile(helper, "w") as archive:
            archive.writestr("extension/fixture.txt", 'github_token = "' + SYNTHETIC + '"\n')
        installer = io.BytesIO()
        with zipfile.ZipFile(installer, "w") as archive:
            archive.writestr("extension/assets/remote.vsix", helper.getvalue())
        with zipfile.ZipFile(str(self.root / "fixture.zip"), "w") as archive:
            archive.writestr("main.vsix", installer.getvalue())
        self.rejected_secret(self.scan())

    def test_deleted_synthetic_secret_in_worktree_history(self):
        def git(*args):
            subprocess.run(["git"] + list(args), cwd=str(self.root), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        git("init", "-b", "main")
        git("config", "user.name", "Publication test fixture")
        git("config", "user.email", "fixture@example.invalid")
        fixture = self.root / "fixture.txt"
        fixture.write_text('github_token = "' + SYNTHETIC + '"\n')
        git("add", ".")
        git("commit", "-m", "Synthetic fixture")
        fixture.unlink()
        git("add", ".")
        git("commit", "-m", "Remove synthetic fixture")
        worktree = pathlib.Path(self.temporary.name) / "worktree"
        git("worktree", "add", "--detach", str(worktree))
        self.assertTrue((worktree / ".git").is_file())
        self.rejected_secret(self.scan(worktree))


if __name__ == "__main__":
    if not shutil.which("gitleaks"):
        raise SystemExit("Install Gitleaks before testing the publication gate.")
    unittest.main()
