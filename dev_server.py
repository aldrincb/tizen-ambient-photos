#!/usr/bin/env python3
"""Local Mac preview & debug server for the Samsung Tizen Ambient Photos .wgt app."""

import http.server
import json
import os
import socketserver
import ssl
import struct
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

PORT = 8090
APP_DIR = Path(__file__).resolve().parent / "app"
UA = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
SSL_CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else ssl.create_default_context()


def ensure_icon(icon_path: Path) -> None:
    """Create a clean 512x512 PNG icon for Tizen .wgt packaging if not present."""
    if icon_path.exists():
        return
    w, h = 128, 128
    raw_rows = []
    for y in range(h):
        row = bytearray([0])  # filter type 0
        for x in range(w):
            # Subtle dark indigo-to-blue gradient icon
            r = int(28 + (x / w) * 60)
            g = int(36 + (y / h) * 90)
            b = int(92 + ((x + y) / (w + h)) * 140)
            row.extend((r, g, b, 255))
        raw_rows.append(bytes(row))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(raw_rows), 9))
        + chunk(b"IEND", b"")
    )
    icon_path.write_bytes(png)


class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/page1":
            qs = urllib.parse.parse_qs(parsed.query)
            share_url = qs.get("url", [""])[0]
            try:
                req = urllib.request.Request(share_url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                    final_url = resp.geturl()
                    html = resp.read().decode("utf-8", errors="ignore")
                payload = json.dumps({"finalUrl": final_url, "html": html}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as exc:
                msg = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/batchexecute":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            try:
                req = urllib.request.Request(
                    "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=snAcKc",
                    data=body,
                    headers={
                        "User-Agent": UA,
                        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    },
                )
                with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                    data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as exc:
                msg = str(exc).encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            return
        self.send_error(404)


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.makedirs(str(APP_DIR), exist_ok=True)
    ensure_icon(APP_DIR / "icon.png")
    os.chdir(str(APP_DIR))
    server = ThreadedHTTPServer(("127.0.0.1", PORT), PreviewHandler)
    print("Tizen Ambient Photos preview running at http://localhost:{}".format(PORT), flush=True)
    server.serve_forever()
