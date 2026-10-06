import hashlib
import importlib.util
import io
import re
import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ipsw_range", Path(__file__).resolve().parents[2] / "scripts/collection/download-ipsw-member.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
URL = "https://updates.cdn-apple.com/test.ipsw"


class Response(io.BytesIO):
    status = 206

    def geturl(self):
        return URL


class Server:
    def __init__(self, data, mutate=None):
        self.data, self.mutate, self.requests = data, mutate, []

    def open(self, request, timeout):
        start, end = map(int, re.fullmatch(r"bytes=(\d+)-(\d+)",
                                         request.get_header("Range")).groups())
        if self.requests:
            assert request.get_header("If-match") == '"fixture-v1"'
        self.requests.append((start, end))
        response = Response(self.data[start:end + 1])
        response.headers = {"Content-Range": f"bytes {start}-{end}/{len(self.data)}",
                            "ETag": '"fixture-v1"'}
        if self.mutate:
            self.mutate(response, len(self.requests))
        return response


def archive_bytes(data=b"localization", compression=zipfile.ZIP_STORED,
                  duplicate=False, symlink=False, zip64=False):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=compression) as archive:
        archive.writestr("unused", b"never extracted")
        info = zipfile.ZipInfo("image.dmg.aea")
        info.compress_type = compression
        if symlink:
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with archive.open(info, "w", force_zip64=zip64) as member:
            member.write(data)
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                archive.writestr("image.dmg.aea", b"duplicate")
    return out.getvalue()


class RangeTests(unittest.TestCase):
    def test_stream_stored_deflate_and_zip64(self):
        data = b"natural translation\n" * 10000
        for compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            for zip64 in (False, True):
                server = Server(archive_bytes(data, compression, zip64=zip64))
                with tempfile.TemporaryDirectory() as output:
                    result = module.download_member(URL, "image.dmg.aea", output,
                                                    len(data) + 1024, server)
                    self.assertEqual(Path(output, "image.dmg.aea").read_bytes(), data)
                    self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
                    self.assertEqual(result["retainedBlocks"], 0)
                    self.assertEqual(len(list(Path(output).iterdir())), 1)
                    with self.assertRaises(ValueError):
                        module.download_member(URL, "image.dmg.aea", output,
                                               len(data) + 1024, server)

    def test_reader_has_no_growing_block_cache(self):
        server = Server(b"z" * (module.CHUNK * 3))
        reader = module.RangeFile(URL, server)
        for _ in range(3):
            self.assertEqual(len(reader.read(module.CHUNK)), module.CHUNK)
        self.assertEqual(reader.read(1), b"")
        self.assertFalse(any(isinstance(v, (bytes, bytearray)) for v in vars(reader).values()))
        reader.seek(0)
        before = len(server.requests)
        reader.read(10)
        self.assertEqual(len(server.requests), before + 1)

    def test_rejects_bad_ranges_encoding_validator_and_identity(self):
        mutations = [
            lambda r, n: setattr(r, "status", 200),
            lambda r, n: r.headers.update({"Content-Range": "bytes 1-1/9"}),
            lambda r, n: r.headers.update({"Content-Encoding": "gzip"}),
            lambda r, n: r.headers.update({"ETag": 'W/"weak"'}),
            lambda r, n: r.headers.pop("ETag"),
            lambda r, n: r.truncate(0),
            lambda r, n: r.headers.update({"ETag": '"changed"'}) if n > 1 else None,
            lambda r, n: r.headers.update({"Content-Range": "bytes 0-1/101"}) if n > 1 else None,
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                reader = module.RangeFile(URL, Server(b"x" * 100, mutation))
                reader.read(2)

    def test_crc_duplicates_symlinks_and_size_limits(self):
        normal = archive_bytes()
        corrupt = normal.replace(b"localization", b"LocalizatIon", 1)
        for content, limit in ((corrupt, 100), (archive_bytes(duplicate=True), 100),
                               (archive_bytes(symlink=True), 100), (normal, 2)):
            with tempfile.TemporaryDirectory() as output:
                with self.assertRaises((ValueError, zipfile.BadZipFile)):
                    module.download_member(URL, "image.dmg.aea", output, limit, Server(content))

    def test_read_limit_and_missing_member(self):
        reader = module.RangeFile(URL, Server(b"x" * 100))
        reader.length = module.READ_LIMIT + 1
        with self.assertRaisesRegex(ValueError, "bounded allocation"):
            reader.read()
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                module.download_member(URL, "missing.dmg", output, 100,
                                       Server(archive_bytes()))

    def test_url_redirect_and_path_policy_before_network(self):
        for url in ("http://updates.cdn-apple.com/a.ipsw", "https://evil.test/a.ipsw",
                    URL + "?token=secret", "https://user@updates.cdn-apple.com/a.ipsw"):
            with self.assertRaises(ValueError):
                module.RangeFile(url)
            with self.assertRaises(ValueError):
                module.AppleRedirect().redirect_request(None, None, 302, "", {}, url)
        for member in ("../image.dmg", "/image.dmg", "a/b.dmg", "image.dmg\x00"):
            with self.assertRaises(ValueError):
                module.download_member(URL, member, "/unused", 100)


if __name__ == "__main__":
    unittest.main()
