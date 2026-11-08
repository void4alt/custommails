#!/usr/bin/env python3
"""Galaxium Mail web UI (real API).

Local dashboard + proxy to https://api.galaxium.art. The API key and mailbox
passwords stay on this machine; the browser only sees addresses and mail.
"""

import argparse
import datetime
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import galaxium

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    server_version = "ZeltconChecker/2.0"
    client = None
    store = None

    def log_message(self, fmt, *args):
        sys.stderr.write("[web] %s\n" % (fmt % args))

    # -- helpers -----------------------------------------------------------

    def _json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, message, status=500, code=None):
        body = {"error": message}
        if code:
            body["code"] = code
        self._json(body, status=status)

    def _body_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _file(self, path, content_type):
        with open(path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _guard(self, fn):
        try:
            fn()
        except galaxium.GalaxiumError as exc:
            self._error(str(exc), status=502, code=exc.code)
        except Exception as exc:  # noqa: BLE001
            self._error("unexpected error: %s" % exc, status=500)

    def _creds(self, inbox):
        item = self.store.find(inbox)
        if not item:
            raise galaxium.GalaxiumError("No stored mailbox for %s" % inbox, status=404, code="not_stored")
        return item

    def _send_attachment(self, inbox, mid, index, folder, filename):
        item = self._creds(inbox)
        content, ctype, api_name = self.client.get_attachment(
            item["email"], item["password"], mid, index, folder=folder
        )
        name = filename or api_name or ("attachment-%s" % index)
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%s" % urllib.parse.quote(name))
        self.end_headers()
        self.wfile.write(content)

    # -- GET ---------------------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        def q(name, default=None):
            values = query.get(name)
            return values[0] if values else default

        if route in ("/", "/index.html"):
            return self._guard(lambda: self._file(os.path.join(HERE, "index.html"), "text/html; charset=utf-8"))

        if route in ("/fernhollow", "/fernhollow.html"):
            return self._guard(lambda: self._file(os.path.join(HERE, "fernhollow.html"), "text/html; charset=utf-8"))

        if route in ("/fernhollow-standalone", "/fernhollow-standalone.html"):
            return self._guard(lambda: self._file(os.path.join(HERE, "fernhollow-standalone.html"), "text/html; charset=utf-8"))

        if route in ("/zeltcon", "/zeltcon.html", "/tempmail"):
            return self._guard(lambda: self._file(os.path.join(HERE, "zeltcon.html"), "text/html; charset=utf-8"))

        if route == "/three.min.js":
            return self._guard(lambda: self._file(os.path.join(HERE, "three.min.js"), "application/javascript; charset=utf-8"))

        if route.startswith("/fonts/"):
            font_name = os.path.basename(route)
            return self._guard(lambda: self._file(os.path.join(HERE, "fonts", font_name), "font/woff2"))

        if route.startswith("/_next/") or route.startswith("/valley/"):
            rel = os.path.normpath(route.lstrip("/"))
            full_local = os.path.join(HERE, rel)
            if os.path.isfile(full_local):
                _, ext = os.path.splitext(full_local)
                ext = ext.lower()
                mimes = {
                    ".js": "application/javascript; charset=utf-8",
                    ".json": "application/json; charset=utf-8",
                    ".png": "image/png",
                    ".glb": "model/gltf-binary",
                    ".mp3": "audio/mpeg",
                    ".css": "text/css; charset=utf-8",
                    ".html": "text/html; charset=utf-8",
                }
                return self._guard(lambda: self._file(full_local, mimes.get(ext, "application/octet-stream")))

        if route == "/favicon.svg":
            svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#090d16"/><path d="M6 9h20c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V11c0-1.1.9-2 2-2z" fill="none" stroke="#38bdf8" stroke-width="2"/><path d="M5 10l11 8 11-8" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#6366f1"/></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(svg)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            return self.wfile.write(svg)

        if route == "/api/health":
            cfg = self.client.config
            return self._guard(lambda: self._json({
                "live": True,
                "brand": "Zeltcon Checker",
                "base_url": cfg.get("base_url") or "",
                "has_key": bool((cfg.get("api_key") or "").strip()),
                "stored": len(self.store.load()),
            }))

        if route == "/api/meta":
            def meta():
                out = {}
                for key, call in (("count", self.client.count),
                                  ("key_age", self.client.key_age),
                                  ("uptime", self.client.uptime)):
                    try:
                        out[key] = call()
                    except galaxium.GalaxiumError as exc:
                        out[key] = {"error": str(exc)}
                self._json(out)
            return self._guard(meta)

        if route == "/api/domains":
            return self._guard(lambda: self._json(self.client.get_domains()))

        if route == "/api/inboxes":
            return self._guard(lambda: self._json(self.store.public()))

        if route == "/api/mailbox":
            inbox = q("inbox") or q("email")
            if not inbox:
                return self._error("inbox or email is required", status=400)
            return self._guard(lambda: self._json(self._public(self._creds(inbox))))

        if route == "/api/messages":
            inbox = q("inbox") or q("email")
            if not inbox:
                return self._error("inbox or email is required", status=400)
            page = int(q("page", "0"))
            per_page = int(q("per_page", "10"))
            folder = q("folder", "inbox")

            def go():
                item = self._creds(inbox)
                data = self.client.list_messages(
                    item["email"], item["password"], page=page, per_page=per_page, folder=folder)
                if data and isinstance(data.get("messages"), list):
                    for m in data["messages"]:
                        if not m.get("code"):
                            m["code"] = galaxium.extract_code("", m.get("snippet") or m.get("subject") or "")
                    if data["messages"]:
                        for m in data["messages"][:3]:
                            if not m.get("code"):
                                try:
                                    full = self.client.get_message(item["email"], item["password"], m["id"], folder=folder)
                                    b_text = full.get("body_text") or ""
                                    b_html = full.get("body_html") or ""
                                    looks_html = b_text.lstrip()[:15].lower().startswith("<!doctype") or "<html" in b_text[:300].lower()
                                    if looks_html and not b_html:
                                        b_html = b_text
                                        b_text = galaxium.html_to_text(b_text)
                                    needs_imap = (not b_text and not b_html) or full.get("body_truncated") or looks_html or not full.get("code")
                                    if needs_imap:
                                        try:
                                            imap_full = self.client.fetch_full_body(
                                                item["email"], item["password"],
                                                subject=full.get("subject"), date=full.get("date"),
                                                webmail=item.get("webmail"))
                                            if imap_full:
                                                b_text = imap_full.get("text") or b_text
                                                b_html = imap_full.get("html") or b_html
                                        except Exception:
                                            pass
                                    code = galaxium.extract_code(b_html, b_text, subject=full.get("subject") or "")
                                    if code:
                                        m["code"] = code
                                except Exception:
                                    pass
                self._json(data)
            return self._guard(go)

        if route == "/api/search":
            inbox = q("inbox") or q("email")
            term = q("q", "")
            if not inbox:
                return self._error("inbox or email is required", status=400)
            page = int(q("page", "0"))
            per_page = int(q("per_page", "10"))

            def go():
                item = self._creds(inbox)
                self._json(self.client.search_messages(
                    item["email"], item["password"], term, page=page, per_page=per_page))
            return self._guard(go)

        if route == "/api/message":
            inbox = q("inbox") or q("email")
            mid = q("id")
            if not inbox or not mid:
                return self._error("inbox (or email) and id are required", status=400)
            folder = q("folder", "inbox")

            def go():
                item = self._creds(inbox)
                msg = self.client.get_message(item["email"], item["password"], mid, folder=folder)
                body = msg.get("body_text") or ""
                looks_html = body.lstrip()[:15].lower().startswith("<!doctype") or "<html" in body[:300].lower()
                if looks_html and not msg.get("body_html"):
                    msg["body_html"] = body
                    msg["body_text"] = galaxium.html_to_text(body)
                needs_imap = (not msg.get("body_text") and not msg.get("body_html")) or msg.get("body_truncated") or looks_html or not msg.get("code")
                if needs_imap:
                    try:
                        full = self.client.fetch_full_body(
                            item["email"], item["password"],
                            subject=msg.get("subject"), date=msg.get("date"),
                            webmail=item.get("webmail"))
                    except galaxium.GalaxiumError as exc:
                        full = None
                        msg["full_error"] = str(exc)
                    if full:
                        msg["body_html"] = full.get("html") or msg.get("body_html")
                        msg["body_text"] = full.get("text") or msg.get("body_text")
                        msg["code"] = full.get("code")
                        msg["body_truncated"] = False
                        msg["full_source"] = "imap"
                if not msg.get("code"):
                    msg["code"] = galaxium.extract_code(msg.get("body_html") or "", msg.get("body_text") or "", subject=msg.get("subject") or "")
                self._json(msg)
            return self._guard(go)

        if route == "/api/attachment":
            inbox = q("inbox") or q("email")
            mid, index = q("id"), q("index")
            if not inbox or not mid or index is None:
                return self._error("inbox (or email), id and index are required", status=400)
            folder = q("folder", "inbox")
            return self._guard(lambda: self._send_attachment(inbox, mid, index, folder, q("filename")))

        if route == "/api/attachment/scan":
            inbox = q("inbox") or q("email")
            mid = q("id")
            if not inbox or not mid:
                return self._error("inbox (or email) and id are required", status=400)
            folder = q("folder", "inbox")
            max_index = int(q("max", "10"))

            def scan():
                item = self._creds(inbox)
                found = []
                for index in range(max_index):
                    try:
                        content, ctype, name = self.client.get_attachment(
                            item["email"], item["password"], mid, index, folder=folder)
                    except galaxium.GalaxiumError as exc:
                        if exc.code == "attachment_not_found" or exc.status == 404:
                            break
                        raise
                    found.append({
                        "index": index,
                        "filename": name or ("attachment-%d" % index),
                        "size": len(content),
                        "content_type": ctype,
                    })
                self._json(found)
            return self._guard(scan)

        if route == "/api/mailbox/reveal":
            inbox = q("inbox") or q("email")
            if not inbox:
                return self._error("inbox or email is required", status=400)

            def reveal():
                item = self._creds(inbox)
                self._json({"email": item["email"], "password": item.get("password"),
                            "webmail": item.get("webmail")})
            return self._guard(reveal)

        return self._error("not found", status=404)

    def _public(self, item):
        return {k: item.get(k) for k in ("email", "domain", "webmail", "created")}

    # -- POST --------------------------------------------------------------

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/inboxes":
            return self._error("not found", status=404)
        body = self._body_json()
        name = (body.get("name") or "").strip() or None
        domain = (body.get("domain") or "").strip() or None

        def go():
            result = self.client.create_inbox(domain=domain, local_part=name)
            email = result.get("email")
            if not email:
                raise galaxium.GalaxiumError("API did not return an email address")
            item = {
                "email": email,
                "password": result.get("password"),
                "webmail": result.get("webmail"),
                "domain": email.split("@")[-1] if "@" in email else domain,
                "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            self.store.upsert(item)
            self._json(self._public(item))
        return self._guard(go)

    # -- DELETE (forget locally; the API cannot delete mailboxes) ----------

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path != "/api/inboxes":
            return self._error("not found", status=404)
        inbox = (query.get("inbox") or query.get("email") or [None])[0]
        if not inbox:
            return self._error("inbox is required", status=400)
        self.store.remove(inbox)
        return self._json({"ok": True})


def bind_server(host, port, tries=25):
    last = None
    for candidate in range(port, port + tries):
        try:
            return ThreadingHTTPServer((host, candidate), Handler), candidate
        except OSError as exc:
            last = exc
    raise last


def main(argv=None):
    parser = argparse.ArgumentParser(description="Galaxium Mail web UI")
    parser.add_argument("--config", help="path to config.json")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    try:
        client = galaxium.GalaxiumClient(config_path=args.config)
    except galaxium.GalaxiumError as exc:
        print("config error: %s" % exc, file=sys.stderr)
        return 2

    store_path = os.path.join(HERE, client.config.get("inbox_store", "inboxes.json"))
    Handler.client = client
    Handler.store = galaxium.Store(store_path)

    try:
        server, port = bind_server(args.host, args.port)
    except OSError as exc:
        print("could not bind a port near %d: %s" % (args.port, exc), file=sys.stderr)
        return 2
    if port != args.port:
        print("port %d was busy, using %d instead" % (args.port, port))
    print("Zeltcon Checker [LIVE] -> http://%s:%d" % (args.host, port))
    print("API: %s" % (client.config.get("base_url") or ""))
    if not (client.config.get("api_key") or "").strip():
        print("WARNING: no api_key set in config.json")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
