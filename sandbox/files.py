"""The files of one VM, for the Directory tab: list folders, read, save, upload, delete.

Everything runs inside the VM through VM.exec, as the desktop user, so it may
do exactly what that user may do: their own files yes, system files only to
read where Linux allows it. File contents travel as base64 text.

    files = Files(session.vm)
    files.home()                         # "/home/ubuntu"
    files.list("/home/ubuntu")           # [{"name", "type": "dir" | "file", "size", "modified"}, ...]
    files.read("/home/ubuntu/notes.txt") # {"kind": "text", "text": ..., "size": ...}
    files.write("/home/ubuntu/notes.txt", b"hello")
    files.delete("/home/ubuntu/old")
"""

import base64
import posixpath
import shlex

from sandbox.vm import VM

# Bigger files are not shown in the page (they can still be downloaded).
SHOW_LIMIT = 1024 * 1024
IMAGE_SHOW_LIMIT = 10 * 1024 * 1024
# Downloads and uploads bigger than this are refused: they travel through memory.
TRANSFER_LIMIT = 100 * 1024 * 1024
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
}


class FilesError(Exception):
    pass


class Files:
    def __init__(self, vm: VM):
        self.vm = vm

    def clean_path(self, path: str) -> str:
        """An absolute path with no ".." or doubled slashes left in it."""
        if not path.startswith("/"):
            raise FilesError(f"Not an absolute path: {path}")
        return posixpath.normpath(path).replace("//", "/")

    def home(self) -> str:
        result = self.vm.exec('echo "$HOME"', timeout=30)
        if result.returncode != 0:
            raise FilesError(f"Could not find the home folder: {result.stderr.strip()}")
        return result.stdout.strip()

    def list(self, path: str) -> list[dict]:
        """What is in a folder: folders first, then files, each by name."""
        path = self.clean_path(path)
        quoted = shlex.quote(path)
        # %Y: the type, following links (d = folder). Fields split by tabs, entries by NUL.
        command = (
            f"test -d {quoted} || {{ echo 'No such folder' >&2; exit 3; }}; "
            f"test -r {quoted} -a -x {quoted} || {{ echo 'Not allowed to open this folder' >&2; exit 3; }}; "
            f"find {quoted} -mindepth 1 -maxdepth 1 -printf '%Y\\t%s\\t%T@\\t%f\\0'"
        )
        result = self.vm.exec(command, timeout=60)
        if result.returncode == 3:
            raise FilesError(result.stderr.strip())
        # find exits 1 when it can't look at some entries; the rest still came out.
        if result.returncode != 0 and not result.stdout:
            raise FilesError(f"Could not open the folder: {result.stderr.strip()}")

        folders = []
        files = []
        for entry in result.stdout.split("\0"):
            if not entry:
                continue
            kind, size, modified, name = entry.split("\t", 3)
            item = {"name": name, "type": "dir" if kind == "d" else "file", "size": int(size), "modified": float(modified)}
            if kind == "d":
                folders.append(item)
            else:
                files.append(item)
        folders.sort(key=lambda item: item["name"].lower())
        files.sort(key=lambda item: item["name"].lower())
        return folders + files

    def size(self, path: str) -> int:
        """The size of a file the user may read, in bytes."""
        quoted = shlex.quote(path)
        command = (
            f"test -f {quoted} || {{ echo 'No such file' >&2; exit 3; }}; "
            f"test -r {quoted} || {{ echo 'Not allowed to read this file' >&2; exit 3; }}; "
            f"stat -c %s {quoted}"
        )
        result = self.vm.exec(command, timeout=30)
        if result.returncode == 3:
            raise FilesError(result.stderr.strip())
        if result.returncode != 0:
            raise FilesError(f"Could not read the file: {result.stderr.strip()}")
        return int(result.stdout.strip())

    def read_bytes(self, path: str) -> bytes:
        """The whole file (up to TRANSFER_LIMIT), for downloads."""
        path = self.clean_path(path)
        size = self.size(path)
        if size > TRANSFER_LIMIT:
            raise FilesError(f"The file is too big to download here ({size // 1024 // 1024} MB, the limit is {TRANSFER_LIMIT // 1024 // 1024} MB)")
        result = self.vm.exec(f"base64 -w0 {shlex.quote(path)}", timeout=300)
        if result.returncode != 0:
            raise FilesError(f"Could not read the file: {result.stderr.strip()}")
        return base64.b64decode(result.stdout)

    def read(self, path: str) -> dict:
        """A file for showing in the page.

        kind is "text" (with text), "image" (with mime and base64 data),
        "binary" (can't be shown) or "too_big" (bigger than the page shows).
        """
        path = self.clean_path(path)
        size = self.size(path)
        extension = posixpath.splitext(path)[1].lower()
        mime = IMAGE_TYPES.get(extension)
        limit = IMAGE_SHOW_LIMIT if mime else SHOW_LIMIT
        if size > limit:
            return {"kind": "too_big", "size": size}

        result = self.vm.exec(f"base64 -w0 {shlex.quote(path)}", timeout=120)
        if result.returncode != 0:
            raise FilesError(f"Could not read the file: {result.stderr.strip()}")
        if mime:
            return {"kind": "image", "size": size, "mime": mime, "data": result.stdout}
        content = base64.b64decode(result.stdout)
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            return {"kind": "binary", "size": size}
        if "\0" in text:
            return {"kind": "binary", "size": size}
        return {"kind": "text", "size": size, "text": text}

    def write(self, path: str, content: bytes) -> None:
        """Create or replace a file with content."""
        path = self.clean_path(path)
        if len(content) > TRANSFER_LIMIT:
            raise FilesError(f"The file is too big ({len(content) // 1024 // 1024} MB, the limit is {TRANSFER_LIMIT // 1024 // 1024} MB)")
        quoted = shlex.quote(path)
        folder = shlex.quote(posixpath.dirname(path))
        command = (
            f"test -d {quoted} && {{ echo 'There is a folder with that name' >&2; exit 3; }}; "
            f"test -e {quoted} -a ! -w {quoted} && {{ echo 'Not allowed to change this file' >&2; exit 3; }}; "
            f"test -e {quoted} -o -w {folder} || {{ echo 'Not allowed to add files to this folder' >&2; exit 3; }}; "
            f"base64 -d > {quoted}"
        )
        result = self.vm.exec(command, timeout=300, input=base64.b64encode(content).decode())
        if result.returncode == 3:
            raise FilesError(result.stderr.strip())
        if result.returncode != 0:
            raise FilesError(f"Could not save the file: {result.stderr.strip()}")

    def delete(self, path: str) -> None:
        """Delete a file, or a folder with everything in it. Never / or the home folder."""
        path = self.clean_path(path)
        if path == "/" or path == self.home():
            raise FilesError("The system root and the home folder can't be deleted")
        quoted = shlex.quote(path)
        command = f"test -e {quoted} -o -L {quoted} || {{ echo 'No such file or folder' >&2; exit 3; }}; rm -rf -- {quoted}"
        result = self.vm.exec(command, timeout=300)
        if result.returncode == 3:
            raise FilesError(result.stderr.strip())
        if result.returncode != 0:
            raise FilesError(f"Could not delete everything (some of it may be gone): {result.stderr.strip()}")
