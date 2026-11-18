"""Scan only this repository and its release archives; never print matched values."""

import io
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP = {".git", "node_modules", "__pycache__", "coverage"}
PRIVATE_PATH = re.compile(r"/(?:Users|home)/(?!runner(?:/|\b)|user(?:/|\b)|example(?:/|\b))[^/\s\"'`]+")
PRIVATE_IP = re.compile(r"(?<![\w.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?![\w.])")
FORBIDDEN_NAMES = {"auth.json", "config.toml", ".DS_Store", "id_rsa", "id_ed25519"}
FORBIDDEN_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".db", ".sqlite", ".sqlite3", ".bak", ".log"}


def inspect(name, data, findings, archive_files, depth=0):
    path = pathlib.PurePosixPath(name)
    if path.name in FORBIDDEN_NAMES or path.suffix in FORBIDDEN_SUFFIXES or path.name.startswith(".env"):
        findings.append((name, "sensitive filename"))
    if data.startswith(b"PK\x03\x04"):
        if depth >= 4:
            findings.append((name, "archive nesting limit"))
            return
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if sum(item.file_size for item in archive.infolist()) > 64 * 1024 * 1024:
                    findings.append((name, "archive size limit"))
                    return
                for item in archive.infolist():
                    if not item.is_dir():
                        inspect(name + "!/" + item.filename, archive.read(item), findings, archive_files, depth + 1)
        except (OSError, ValueError, zipfile.BadZipFile):
            findings.append((name, "unreadable archive"))
        return
    if depth:
        # Gitleaks does not recognize every VSIX archive by its extension.
        # Scan members separately, with generated safe filenames, too.
        archive_files.append(data)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return
    for index, line in enumerate(text.splitlines(), 1):
        if PRIVATE_PATH.search(line):
            findings.append((name + ":" + str(index), "personal filesystem path"))
        if PRIVATE_IP.search(line):
            findings.append((name + ":" + str(index), "private network address"))


def main():
    scanner = shutil.which("gitleaks")
    if not scanner:
        print("Install Gitleaks before publishing; the scan cannot be skipped.", file=sys.stderr)
        return 1
    findings = []
    archive_files = []
    for directory, folders, filenames in os.walk(str(ROOT), followlinks=False):
        for folder in folders:
            child = pathlib.Path(directory) / folder
            if folder not in SKIP and child.is_symlink():
                findings.append((child.relative_to(ROOT).as_posix(), "symlink is not a publication input"))
        folders[:] = [folder for folder in folders if folder not in SKIP and not (pathlib.Path(directory) / folder).is_symlink()]
        for filename in filenames:
            file = pathlib.Path(directory) / filename
            relative = file.relative_to(ROOT)
            if file.is_symlink():
                findings.append((relative.as_posix(), "symlink is not a publication input"))
                continue
            if file.stat().st_size > 64 * 1024 * 1024:
                findings.append((relative.as_posix(), "file size limit"))
                continue
            inspect(relative.as_posix(), file.read_bytes(), findings, archive_files)
    for name, reason in findings:
        print(f"Blocked: {name} ({reason}); matched content redacted.", file=sys.stderr)
    if findings:
        return 1
    command = [scanner, "dir", str(ROOT), "--config", str(ROOT / ".gitleaks.toml"), "--redact=100", "--no-banner", "--max-archive-depth=4"]
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode:
        return result.returncode
    if archive_files:
        with tempfile.TemporaryDirectory(prefix="bridge-publication-scan-") as directory:
            for index, data in enumerate(archive_files):
                (pathlib.Path(directory) / ("member-%06d.txt" % index)).write_bytes(data)
            result = subprocess.run([scanner, "dir", directory, "--config", str(ROOT / ".gitleaks.toml"), "--redact=100", "--no-banner"], cwd=ROOT)
            if result.returncode:
                return result.returncode
    # Worktrees use a .git file. Never mistake their available history for none.
    repository = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if repository.returncode == 0 and pathlib.Path(repository.stdout.strip()).resolve() == ROOT:
        head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if head.returncode == 0:
            result = subprocess.run([scanner, "git", str(ROOT), "--config", str(ROOT / ".gitleaks.toml"), "--redact=100", "--no-banner", "--log-opts=--all"], cwd=ROOT)
            if result.returncode:
                return result.returncode
    print("Publication files, release archives and available Git history passed scanning.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
