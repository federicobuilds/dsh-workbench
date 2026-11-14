#!/usr/bin/env python3
"""Store immutable HTML revisions under a descriptor-anchored project directory."""
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
from uuid import uuid4

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
STORE = ".shared-memory-html"
HASH = re.compile(r"[a-f0-9]{64}\Z")
CONFLICT = re.compile(r"^(?:HEAD[ .(]|authority\.json[ .(])")


def anchor(path):
    fd = os.open("/", DIR)
    try:
        for part in path.split("/")[1:]:
            if part in ("", ".", ".."):
                raise ValueError("Invalid memory root")
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def directory(fd, name, create=False):
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=fd)
        except FileExistsError:
            pass
    child = os.open(name, DIR, dir_fd=fd)
    if os.fstat(child).st_uid != os.getuid():
        os.close(child)
        raise ValueError("Memory directory has an unexpected owner")
    return child


def read(fd, name, optional=False, limit=32 << 20):
    try:
        handle = os.open(name, FILE, dir_fd=fd)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(handle, "rb") as stream:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Expected a regular owned memory file")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Memory file exceeds its size limit")
        return data.decode("utf-8")


def write(fd, name, body):
    name_tmp = ".tmp-" + uuid4().hex
    try:
        handle = os.open(name_tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        with os.fdopen(handle, "wb") as stream:
            stream.write(body.encode("utf-8"))
            stream.flush()
            os.fsync(handle)
        os.rename(name_tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name_tmp, dir_fd=fd)
        except FileNotFoundError:
            pass


def read_state(fd, store, revision=None):
    head = read(store, "HEAD", optional=True, limit=256)
    if head and not HASH.fullmatch(head):
        raise ValueError("Invalid authority pointer")
    if any(CONFLICT.match(name) and name != "HEAD" for name in os.listdir(store)):
        raise ValueError("A conflicting cloud copy of the authority pointer requires reconciliation")
    version = revision or head
    if not version:
        return {"head": None}
    if not HASH.fullmatch(version):
        raise ValueError("Invalid revision")
    revision_fd = directory(store, version)
    try:
        manifest = read(revision_fd, "manifest.json")
        descriptor = json.loads(manifest)
        filenames = descriptor["files"]
        if not isinstance(filenames, dict) or len(filenames) > 2000:
            raise ValueError("Invalid revision manifest")
        records = {}
        size = len(manifest)
        for filename in filenames:
            if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,79}\.html", filename):
                raise ValueError("Invalid HTML record filename")
            records[filename] = read(revision_fd, filename, limit=4 << 20)
            size += len(records[filename].encode())
            if size > 96 << 20:
                raise ValueError("Revision exceeds its size limit")
        return {"head": head, "manifest": manifest, "files": records,
                "publication": read(store, "published", optional=True, limit=256),
                "viewer": read(store, "memory.html", optional=True, limit=48 << 20),
                "index": read(store, "memory.index.json", optional=True)}
    finally:
        os.close(revision_fd)


def put_revision(store, request):
    revision = request["revision"]
    if not HASH.fullmatch(revision):
        raise ValueError("Invalid revision")
    stage = ".stage-" + uuid4().hex
    tmp = directory(store, stage, create=True)
    moved = False
    try:
        write(tmp, "manifest.json", request["manifest"])
        for filename, html in request["files"].items():
            if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,79}\.html", filename):
                raise ValueError("Invalid HTML record filename")
            write(tmp, filename, html)
        try:
            os.rename(stage, revision, src_dir_fd=store, dst_dir_fd=store)
            moved = True
        except OSError:
            existing = directory(store, revision)
            try:
                if read(existing, "manifest.json") != request["manifest"]:
                    raise ValueError("Revision collision")
                if any(read(existing, name) != html for name, html in request["files"].items()):
                    raise ValueError("Existing revision is damaged")
            finally:
                os.close(existing)
        os.fsync(store)
    finally:
        if not moved:
            for filename in os.listdir(tmp):
                os.unlink(filename, dir_fd=tmp)
        os.close(tmp)
        if not moved:
            os.rmdir(stage, dir_fd=store)


def reminder_state(store):
    content = read(store, "reminders.json", optional=True, limit=16 << 20)
    if content is None:
        return {"revision": None, "records": []}
    records = json.loads(content)
    if not isinstance(records, list):
        raise ValueError("Invalid shared reminder storage")
    return {"revision": hashlib.sha256(content.encode()).hexdigest(), "records": records}


def transact(fd, store, command, request):
    if command == "reminders-read":
        return reminder_state(store)
    if command == "read":
        return read_state(fd, store, request.get("revision"))
    lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=store)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Expected an owned regular lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        if command == "reminders-write":
            if any(name.startswith(("reminders (", "reminders.json.", "reminders.json ")) for name in os.listdir(store)):
                raise ValueError("A conflicting cloud reminder copy requires reconciliation")
            old = reminder_state(store)
            if old["revision"] != request["expected"]:
                return {"conflict": True, "revision": old["revision"]}
            records = request["records"]
            if not isinstance(records, list) or len(records) > 10000:
                raise ValueError("Invalid shared reminder storage")
            body = json.dumps(records, ensure_ascii=False, separators=(",", ":"))
            if len(body.encode()) > 16 << 20:
                raise ValueError("Shared reminder storage exceeds its size limit")
            write(store, "reminders.json", body)
            return {"revision": hashlib.sha256(body.encode()).hexdigest()}
        head = read(store, "HEAD", optional=True, limit=256)
        if any(CONFLICT.match(name) and name != "HEAD" for name in os.listdir(store)):
            raise ValueError("A conflicting cloud copy of the authority pointer requires reconciliation")
        if head != request["expected"]:
            return {"conflict": True, "revision": head}
        if command in ("stage", "commit"):
            put_revision(store, request)
        if command == "commit":
            write(store, "HEAD", request["revision"])
        if command == "activate":
            target = request["revision"]
            if not HASH.fullmatch(target):
                raise ValueError("Invalid revision")
            os.close(directory(store, target))
            write(store, "HEAD", target)
        if command == "publish":
            write(store, "memory.html", request["viewer"])
            write(store, "memory.index.json", request["index"])
            write(store, "published", head)
        if command == "rollback":
            target = request["revision"]
            if not HASH.fullmatch(target):
                raise ValueError("Invalid revision")
            os.close(directory(store, target))
            write(store, "LAST_HTML_HEAD", head)
            os.unlink("HEAD", dir_fd=store)
            os.fsync(store)
        return {"ok": True}
    finally:
        os.close(lock)


def main():
    command, root = sys.argv[1:]
    request = json.loads(sys.stdin.read(160 << 20))
    fd = anchor(root)
    try:
        try:
            store = directory(fd, STORE, create=command in ("stage", "reminders-write"))
        except FileNotFoundError:
            if command == "reminders-read":
                return {"revision": None, "records": []}
            if command == "read" and not request.get("revision"):
                return {"head": None}
            raise
        try:
            return transact(fd, store, command, request)
        finally:
            os.close(store)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
