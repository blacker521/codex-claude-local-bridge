"""Verify exact release contents, embedded helper identity and SHA-256 hashes."""

import hashlib
import io
import json
import pathlib
import posixpath
import re
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
PREFIX = "codex-local-bridge-" + VERSION
MAIN = PREFIX + ".vsix"
CHECKSUMS = "SHA256SUMS-" + VERSION + ".txt"


def verify_links(archive, filename):
    for target in re.findall(r"\]\(([^)]+)\)", archive.read(filename).decode("utf-8")):
        if ":" in target or target.startswith("#"):
            continue
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(filename), target.split("#", 1)[0]))
        assert resolved in archive.namelist(), "Broken relative documentation link in archive"


def verify_component(data, side):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        expected = {"extension.vsixmanifest", "[Content_Types].xml", "extension/package.json", "extension/readme.md", "extension/README.zh-CN.md", "extension/LICENSE.txt"}
        for file in (ROOT / side / "src").iterdir():
            if file.is_file():
                name = "extension/src/" + file.name
                expected.add(name)
                assert archive.read(name) == file.read_bytes(), "Source content mismatch"
        if side == "local":
            expected.add("extension/assets/remote.vsix")
        assert len(archive.namelist()) == len(expected) and set(archive.namelist()) == expected, "Unexpected VSIX files"
        assert archive.read("extension/readme.md") == (ROOT / side / "README.md").read_bytes(), "Guide content mismatch"
        assert archive.read("extension/README.zh-CN.md") == (ROOT / side / "README.zh-CN.md").read_bytes(), "Chinese guide content mismatch"
        verify_links(archive, "extension/readme.md")
        verify_links(archive, "extension/README.zh-CN.md")
        assert archive.read("extension/LICENSE.txt") == (ROOT / "LICENSE").read_bytes(), "License mismatch"
        manifest = json.loads(archive.read("extension/package.json").decode("utf-8"))
        assert manifest == json.loads((ROOT / side / "package.json").read_text()), "Manifest mismatch"
        assert manifest["version"] == VERSION and manifest["publisher"] == "vectory-local", "Extension identity mismatch"
        assert manifest["extensionKind"] == (["ui"] if side == "local" else ["workspace"]), "Incorrect extension host"
        if side == "local":
            assert manifest["api"] == "none", "Cross-host bridge metadata mismatch"
            assert any(c["command"] == "codexLocalBridge.installRemote" for c in manifest["contributes"]["commands"]), "Installer command missing"
            verify_component(archive.read("extension/assets/remote.vsix"), "remote")
        else:
            assert manifest["extensionDependencies"] == ["vectory-local.codex-local-bridge-local"], "Local dependency mismatch"


def main():
    verify_component((ROOT / "dist" / MAIN).read_bytes(), "local")
    documents = {"README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md", "CHANGELOG.zh-CN.md", "SECURITY.md", "SECURITY.zh-CN.md", "CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md", "local/README.md", "local/README.zh-CN.md", "remote/README.md", "remote/README.zh-CN.md"}
    with zipfile.ZipFile(str(ROOT / "dist" / (PREFIX + ".zip"))) as archive:
        expected = {PREFIX + "/" + name for name in documents}
        expected.update({PREFIX + "/dist/" + MAIN, PREFIX + "/dist/" + CHECKSUMS})
        assert len(archive.namelist()) == len(expected) and set(archive.namelist()) == expected, "Unexpected ZIP files"
        for name in documents:
            assert archive.read(PREFIX + "/" + name) == (ROOT / name).read_bytes(), "Bundle guide mismatch"
            if name.endswith(".md"):
                verify_links(archive, PREFIX + "/" + name)
        assert archive.read(PREFIX + "/dist/" + MAIN) == (ROOT / "dist" / MAIN).read_bytes(), "Bundled installer mismatch"
        inner = archive.read(PREFIX + "/dist/" + CHECKSUMS).decode("utf-8").splitlines()
        assert len(inner) == 1, "Incorrect inner checksum list"
        digest, filename = inner[0].split("  ", 1)
        assert filename == MAIN and digest == hashlib.sha256((ROOT / "dist" / MAIN).read_bytes()).hexdigest(), "Inner checksum mismatch"
    checksums = (ROOT / "dist" / CHECKSUMS).read_text().splitlines()
    assert len(checksums) == 2, "Incorrect release checksum list"
    assert {line.split("  ", 1)[1] for line in checksums} == {MAIN, PREFIX + ".zip"}, "Unexpected checksum filename"
    for line in checksums:
        digest, filename = line.split("  ", 1)
        assert digest == hashlib.sha256((ROOT / "dist" / filename).read_bytes()).hexdigest(), "Release checksum mismatch"
    print("Single installer, embedded remote component, allowlists and SHA-256 hashes verified.")


if __name__ == "__main__":
    main()
