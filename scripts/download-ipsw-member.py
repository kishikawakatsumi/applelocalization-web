"""Bounded-memory, read-only HTTP range ZIP reader for one pinned IPSW member.

No archive extraction paths, persistent block cache, credentials, or raw uploads.
zipfile supplies ZIP64/deflate/CRC checking; the caller pins BuildManifest first.
"""
import argparse
import hashlib
import io
import json
import os
import re
import stat
import urllib.request
import urllib.parse
import zipfile
from pathlib import Path

READ_LIMIT = 64 * 1024**2  # Also bounds central-directory allocation.
CHUNK = 8 * 1024**2
ARCHIVE_LIMIT = 100 * 1024**3


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_url(url):
    p = urllib.parse.urlsplit(url)
    require(p.scheme == "https" and p.netloc == "updates.cdn-apple.com"
            and not p.query and not p.fragment and p.path.endswith(".ipsw"),
            "Expected credential-free Apple HTTPS IPSW URL")


class AppleRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class RangeFile(io.RawIOBase):
    def __init__(self, url, opener=None):
        super().__init__()
        validate_url(url)
        self.url = url
        self.opener = opener or urllib.request.build_opener(AppleRedirect())
        self.position = 0
        self.length = None
        self.validator = None
        self.bytes_received = 0
        self.requests = 0
        self._fetch(0, 1)

    def _fetch(self, offset, count):
        require(0 < count <= READ_LIMIT, "Range read exceeds bounded allocation")
        headers = {"Range": f"bytes={offset}-{offset + count - 1}",
                   "Accept-Encoding": "identity"}
        if self.validator:
            headers["If-Match"] = self.validator
        request = urllib.request.Request(self.url, headers=headers)
        with self.opener.open(request, timeout=60) as response:
            validate_url(response.geturl())
            require(response.status == 206, "Server did not honor byte range")
            require(response.headers.get("Content-Encoding", "identity") == "identity",
                    "Unexpected content encoding")
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)",
                                 response.headers.get("Content-Range", ""))
            require(match is not None, "Missing or malformed Content-Range")
            start, end, total = map(int, match.groups())
            require(start == offset and end == offset + count - 1
                    and end < total <= ARCHIVE_LIMIT, "Range identity mismatch")
            etag = response.headers.get("ETag", "")
            require(re.fullmatch(r'"[^"\r\n]+"', etag) is not None,
                    "Strong ETag required for coherent range reads")
            if self.length is not None:
                require(total == self.length and etag == self.validator,
                        "Remote IPSW changed during download")
            data = response.read(count + 1)
            require(len(data) == count, "Truncated or excessive range body")
            self.length, self.validator = total, etag
            self.bytes_received += len(data)
            self.requests += 1
            return data

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=os.SEEK_SET):
        require(whence in (os.SEEK_SET, os.SEEK_CUR, os.SEEK_END), "Invalid seek")
        position = offset + (0 if whence == os.SEEK_SET else
                             self.position if whence == os.SEEK_CUR else self.length)
        require(0 <= position <= self.length, "Seek outside remote IPSW")
        self.position = position
        return position

    def read(self, size=-1):
        if size is None or size < 0:
            size = self.length - self.position
        size = min(size, self.length - self.position)
        if size == 0:
            return b""
        data = self._fetch(self.position, size)
        self.position += len(data)
        return data


def download_member(url, member, output, maximum_bytes, opener=None):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:dmg|dmg\.aea)", member)
            is not None, "Expected a root-level image member")
    require(0 < maximum_bytes <= ARCHIVE_LIMIT, "Invalid member byte budget")
    output = Path(output)
    require(output.is_dir() and not output.is_symlink() and not any(output.iterdir()),
            "Expected empty regular output directory")
    with RangeFile(url, opener) as remote, zipfile.ZipFile(remote) as archive:
        matches = [info for info in archive.infolist() if info.filename == member]
        require(len(matches) == 1, "Expected exactly one selected member")
        info = matches[0]
        mode = info.external_attr >> 16
        require(not info.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG)
                and not (info.flag_bits & 1), "Not a regular unencrypted ZIP member")
        require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                "Unsupported ZIP compression")
        require(0 < info.file_size <= maximum_bytes
                and 0 < info.compress_size <= maximum_bytes,
                "Selected member exceeds byte budget or is empty")
        digest, written = hashlib.sha256(), 0
        # Exclusive create: interrupted data is preserved, never overwritten.
        with archive.open(info) as source, (output / member).open("xb") as target:
            while True:
                chunk = source.read(CHUNK)
                if not chunk:
                    break  # zipfile verifies CRC before accepting end-of-file.
                written += len(chunk)
                require(written <= info.file_size and written <= maximum_bytes,
                        "Expanded member exceeds byte budget")
                target.write(chunk)
                digest.update(chunk)
        require(written == info.file_size, "Truncated ZIP member")
        return {"status": "ipsw-member-downloaded-crc-verified", "member": member,
                "bytes": written, "sha256": digest.hexdigest(),
                "archiveBytes": remote.length, "rangeRequests": remote.requests,
                "networkBytes": remote.bytes_received, "chunkBytes": CHUNK,
                "maximumReadBytes": READ_LIMIT, "retainedBlocks": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--member", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--maximum-bytes", type=int, required=True)
    args = parser.parse_args()
    print(json.dumps(download_member(args.url, args.member, args.output, args.maximum_bytes)))
