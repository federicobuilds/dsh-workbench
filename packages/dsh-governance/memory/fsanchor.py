#!/usr/bin/env python3
"""Descriptor-anchored filesystem helper for the project memory viewer (MEMORY-VISUAL-STANDARD, 2026-10-24).

Node has no openat family, so this stdlib-only helper does every traversal, read and publication relative
to directory descriptors: the memory root is opened component by component with O_DIRECTORY|O_NOFOLLOW,
children are opened with dir_fd and O_NOFOLLOW, and each file is fstat-checked (regular, same owner)
on the descriptor that is read. A parent directory swapped during the walk cannot redirect a read,
because no path is ever re-resolved after the anchor is taken.

Commands (argv): scan <memory-root> [--meta]      -> JSON on stdout (content base64 unless --meta)
                 publish <memory-root> <dev> <ino> <name>  <- file body on stdin; renameat into the root
Stdout carries memory data only to the parent Node process; nothing is logged.
"""
import base64
import errno
import hashlib
import json
import os
import stat
import sys
import time

O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0)
OUTPUT_NAME = "memory.html"
# Derived plain-language projection (MEMORY-KNOWLEDGE-ELI5, 2026-10-25): one fixed name at the root only,
# never a source document, read with a size bound checked on the descriptor before any allocation.
READABLE_NAME = "memory.readable.json"
# 2026-10-26 (MEMORY-FORMAT-GLOBAL-P1): hard 16 MiB cap, mirrored in readable.mjs, so a large workspace's full
# explanations fit while an unbounded file is still refused on the descriptor before allocation.
READABLE_MAX = 16 << 20
FIXTURE_DIR = ("runtime", "home")
NOT_REGULAR = "not a regular file"
NOT_OWNED = "not owned by the current user"


def fail(code, message):
    sys.stdout.write(json.dumps({"error": code, "message": message}))
    sys.exit(2)


def open_root(path):
    """Open an absolute, symlink-free directory path one component at a time, anchored at '/'."""
    if not os.path.isabs(path):
        fail("EINVAL", "memory root must be absolute")
    fd = os.open("/", O_DIR)
    try:
        for part in [p for p in path.split("/") if p]:
            if part in (".", ".."):
                fail("EINVAL", "dot components refused")
            try:
                nxt = os.open(part, O_DIR, dir_fd=fd)
            except OSError as error:
                fail(errno.errorcode.get(error.errno, "EIO"), f"{part}: {error.strerror}")
            os.close(fd)
            fd = nxt
    except SystemExit:
        os.close(fd)
        raise
    return fd


def is_fixture(name):
    low = name.lower()
    return any(low == f or low.startswith(f + "-") or low.startswith(f + "_") or low.startswith(f + ".") for f in FIXTURE_DIR)


def read_regular(dir_fd, name, uid, limit=None):
    """Open relative to dir_fd without following symlinks; verify on the descriptor before reading."""
    fd = os.open(name, O_FILE, dir_fd=dir_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(0, NOT_REGULAR)
        if info.st_uid != uid:
            raise OSError(0, NOT_OWNED)
        if limit is not None and info.st_size > limit:
            raise OSError(errno.EFBIG, "file too large")
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, 1 << 20 if limit is None else min(1 << 20, limit + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            chunks.append(chunk)
            if limit is not None and total > limit:
                raise OSError(errno.EFBIG, "file too large")
        return b"".join(chunks), info
    finally:
        os.close(fd)


def read_derived(dir_fd, name, uid, meta_only):
    """Bounded read of the derived projection; failures become a fixed status code, never a message."""
    try:
        data, info = read_regular(dir_fd, name, uid, READABLE_MAX)
    except OSError as error:
        if error.errno == errno.ELOOP:
            return {"status": "symlink"}
        if error.errno == errno.EFBIG:
            return {"status": "oversize"}
        if error.strerror == NOT_REGULAR:
            return {"status": "special"}
        if error.strerror == NOT_OWNED:
            return {"status": "owner"}
        return {"status": "unreadable"}
    found = {"status": "present", "sha256": hashlib.sha256(data).hexdigest(), "size": info.st_size, "mtimeMs": info.st_mtime * 1000, "ino": info.st_ino}
    if not meta_only:
        found["content"] = base64.b64encode(data).decode()
    return found


def scan(root, meta_only):
    uid = os.getuid()
    root_fd = open_root(root)
    sync = os.environ.get("KILO_MEMORY_HELPER_SYNC_FILE")
    if sync:
        # Test barrier: the anchor is taken; wait until the fixture removes the marker, then walk.
        with open(sync, "w") as marker:
            marker.write(str(os.getpid()))
        for _ in range(500):
            if not os.path.exists(sync):
                break
            time.sleep(0.01)
    root_info = os.fstat(root_fd)
    files, excluded, other, unavailable = [], [], {}, []
    output = None
    readable = {"status": "absent"}

    def walk(dir_fd, rel):
        nonlocal output, readable
        try:
            entries = sorted(os.scandir(dir_fd), key=lambda e: e.name)
        except OSError as error:
            unavailable.append({"path": rel + "/", "error": os.strerror(error.errno) if error.errno else str(error)})
            return
        for entry in entries:
            name = entry.name
            path = f"{rel}/{name}" if rel else name
            try:
                is_link = entry.is_symlink()
                is_dir = entry.is_dir(follow_symlinks=False)
                is_file = entry.is_file(follow_symlinks=False)
            except OSError as error:
                unavailable.append({"path": path, "error": os.strerror(error.errno) if error.errno else str(error)})
                continue
            if name.startswith(".") and not is_dir:
                continue
            if not rel and name == OUTPUT_NAME:
                if is_file and not is_link:
                    try:
                        data, info = read_regular(dir_fd, name, uid)
                        output = {"mode": info.st_mode & 0o777, "head": base64.b64encode(data[:4096]).decode()}
                    except OSError:
                        output = None
                continue
            if not rel and name == READABLE_NAME:
                readable = read_derived(dir_fd, name, uid, meta_only)
                continue
            if is_link:
                excluded.append({"path": path, "reason": "symlink"})
            elif name.startswith("."):
                excluded.append({"path": path, "reason": "hidden or config folder"})
            elif is_dir:
                if name == "node_modules":
                    excluded.append({"path": path + "/", "reason": "dependency tree"})
                elif is_fixture(name):
                    excluded.append({"path": path + "/", "reason": "runtime fixture"})
                else:
                    try:
                        child = os.open(name, O_DIR, dir_fd=dir_fd)
                    except OSError as error:
                        unavailable.append({"path": path + "/", "error": os.strerror(error.errno) if error.errno else str(error)})
                        continue
                    try:
                        walk(child, path)
                    finally:
                        os.close(child)
            elif is_file:
                kind = "markdown" if name.lower().endswith(".md") else "status" if name == "status.tsv" else None
                if kind is None:
                    ext = name[name.rfind("."):].lower() if "." in name else "(none)"
                    other[ext] = other.get(ext, 0) + 1
                    continue
                try:
                    data, info = read_regular(dir_fd, name, uid)
                    found = {"rel": path, "kind": kind, "size": info.st_size, "mtimeMs": info.st_mtime * 1000, "ino": info.st_ino}
                    # 2026-10-26: --meta carries the byte hash so an equal-size, equal-mtime edit still changes the signature.
                    if meta_only:
                        found["sha256"] = hashlib.sha256(data).hexdigest()
                    else:
                        found["content"] = base64.b64encode(data).decode()
                    files.append(found)
                except OSError as error:
                    unavailable.append({"path": path, "error": os.strerror(error.errno) if error.errno else str(error)})
            else:
                excluded.append({"path": path, "reason": "special file"})

    try:
        walk(root_fd, "")
    finally:
        os.close(root_fd)
    sys.stdout.write(json.dumps({"root": {"dev": root_info.st_dev, "ino": root_info.st_ino}, "files": files, "excluded": excluded, "otherTypes": other, "unavailable": unavailable, "output": output, "readable": readable}))


def publish(root, dev, ino, name, create_only=False):
    """Atomic 0600 publish. create_only links instead of renaming, so an existing file is never replaced."""
    body = sys.stdin.buffer.read()
    if name not in (OUTPUT_NAME, READABLE_NAME):
        fail("EINVAL", "only the derived view and explanation file can be published")
    root_fd = open_root(root)
    try:
        info = os.fstat(root_fd)
        if (info.st_dev, info.st_ino) != (dev, ino):
            fail("EROOTDRIFT", "memory root identity changed since the snapshot; not publishing")
        temp = f".{name}.{os.urandom(6).hex()}.tmp"
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
        try:
            view = memoryview(body)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        if create_only:
            try:
                os.link(temp, name, src_dir_fd=root_fd, dst_dir_fd=root_fd, follow_symlinks=False)
            except FileExistsError:
                sys.stdout.write(json.dumps({"written": False}))
                return
            finally:
                os.unlink(temp, dir_fd=root_fd)
        else:
            try:
                os.rename(temp, name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
            except OSError:
                os.unlink(temp, dir_fd=root_fd)
                raise
        sys.stdout.write(json.dumps({"written": True}))
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    if sys.platform != "darwin" and not sys.platform.startswith("linux"):
        fail("EPLATFORM", f"descriptor-anchored access is not supported on {sys.platform}")
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "scan":
        scan(args[1], "--meta" in args[2:])
    elif len(args) in (5, 6) and args[0] == "publish" and args[5:] in ([], ["--new"]):
        publish(args[1], int(args[2]), int(args[3]), args[4], args[5:] == ["--new"])
    else:
        fail("EUSAGE", "usage: scan <root> [--meta] | publish <root> <dev> <ino> <name> [--new]")
