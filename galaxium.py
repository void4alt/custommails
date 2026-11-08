"""Galaxium Mail API client (real API: https://api.galaxium.art).

Reads are POST + JSON with mailbox credentials. The API key stays server-side.
Pure standard library, Python 3.8+.
"""

import json
import os
import random
import urllib.error
import urllib.parse
import urllib.request
import imaplib
import email
import email.header
import email.utils
import html as html_lib
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG_PATH = os.path.join(HERE, "config.json")

# Domains containing these fragments are never shown in the picker.
HIDDEN_DOMAIN_PARTS = (
    "rape", "loliporn", "nigger", "foid", "mcvirgins", "killall", "mossad", "getfucked",
)

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def decode_mime_header(value):
    if not value:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(value)))
    except Exception:  # noqa: BLE001
        return value


def html_to_text(markup):
    if not markup:
        return ""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", markup)
    text = re.sub(r"(?s)<!--.*?-->", " ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|li|h[1-6]|table)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _first_code(text):
    if not text:
        return None
    for match in re.finditer(r"(?<!\d)(\d{4,8})(?!\d)", text):
        value = match.group(1)
        if len(value) == 4 and 1900 <= int(value) <= 2099:
            continue
        return value
    return None


def extract_code(markup, plain_text=None, subject=None):
    """Best-effort OTP/verification code extraction."""
    subj = (subject or "").strip()
    if subj:
        subj_match = re.search(r"(?:code|otp|verification|passcode|pin)[^\d\r\n]{0,25}\b(\d{4,8}|\d{3,4}[-\s]\d{3,4}|[A-Z]-\d{4,8})\b", subj, re.I)
        if subj_match:
            return re.sub(r"\s+", "", subj_match.group(1))
        rev_subj = re.search(r"\b(\d{4,8}|\d{3,4}[-\s]\d{3,4})\b[^\r\n]{0,35}(?:is your (?:verification|login|otp|security|confirmation|access) code)", subj, re.I)
        if rev_subj:
            return re.sub(r"\s+", "", rev_subj.group(1))

    plain = plain_text if plain_text is not None else html_to_text(markup or "")
    full = ("%s\n%s" % (subj, plain)).strip()

    prefix_match = re.search(r"\b([A-Z]-\d{4,8})\b", full, re.I)
    if prefix_match and re.search(r"(?:google|microsoft|code|verification|otp|security)", full, re.I):
        return prefix_match.group(1).upper()

    rev_context = re.search(
        r"\b(\d{4,8}|\d{3,4}[-\s]\d{3,4})\b[^\r\n]{0,45}(?:is your (?:verification|login|otp|security|confirmation|access) code)",
        full,
        re.I,
    )
    if rev_context:
        return re.sub(r"\s+", "", rev_context.group(1))

    fwd_context = re.search(
        r"(?:code|otp|verification|passcode|pin|token|secret)[^\d]{0,60}\b(\d{4,8}|\d{3,4}[-\s]\d{3,4}|(?=[A-Z0-9]*\d)[A-Z0-9]{5,8})\b",
        full,
        re.I,
    )
    if fwd_context:
        candidate = re.sub(r"\s+", "", fwd_context.group(1))
        if candidate.lower() not in ("please", "code", "verify", "security", "account", "password"):
            return candidate

    if markup:
        for pattern in (
            r'class="[^"]*\bcode[_-]?text\b[^"]*"[^>]*>(.*?)</td>',
            r'class="[^"]*\bcode[_-]?text\b[^"]*"[^>]*>(.*?)</div>',
            r'class="[^"]*\botp\b[^"]*"[^>]*>(.*?)</(?:td|div)>',
            r'id="[^"]*\b(?:otp|verification|code)\b[^"]*"[^>]*>(.*?)</[a-z0-9]+>',
            r'>\s*(\d{4,8}|\d{3,4}[-\s]\d{3,4})\s*<',
        ):
            match = re.search(pattern, markup, re.I | re.S)
            if match:
                clean = re.sub(r"\s+", "", re.sub(r"<[^>]+>", " ", match.group(1))).strip()
                if 4 <= len(clean) <= 10:
                    val = int(clean.replace("-", "")) if clean.replace("-", "").isdigit() else 0
                    if not (len(clean) == 4 and 1900 <= val <= 2099):
                        return clean

    return _first_code(plain) or _first_code(markup or "")


def _decode_part(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, "replace")
    except LookupError:
        return payload.decode("utf-8", "replace")


def _same_moment(a, b):
    try:
        da = email.utils.parsedate_to_datetime(a)
        db = email.utils.parsedate_to_datetime(b)
        return abs((da - db).total_seconds()) < 120
    except (TypeError, ValueError):
        return False


class ImapReader:
    """Pull the full, untruncated message from the mailbox over IMAP."""

    def __init__(self, host, port=993, timeout=20):
        self.host = host
        self.port = int(port)
        self.timeout = timeout

    def fetch_full(self, user, password, subject=None, date=None):
        conn = imaplib.IMAP4_SSL(self.host, self.port, timeout=self.timeout)
        try:
            conn.login(user, password)
            conn.select("INBOX")
            typ, data = conn.search(None, "ALL")
            ids = data[0].split() if data and data[0] else []
            fallback = None
            for num in reversed(ids):
                typ, parts = conn.fetch(num, "(BODY.PEEK[])")
                raw = None
                for item in parts:
                    if isinstance(item, tuple) and len(item) > 1:
                        raw = item[1]
                        break
                if not raw:
                    continue
                msg = email.message_from_bytes(raw)
                subj = decode_mime_header(msg.get("Subject")).strip()
                if subject and subj != subject.strip():
                    continue
                result = self._extract(msg)
                if date and result.get("date") and not _same_moment(date, result["date"]):
                    fallback = fallback or result
                    continue
                return result
            return fallback
        finally:
            try:
                conn.logout()
            except Exception:  # noqa: BLE001
                pass

    def _extract(self, msg):
        html_part = None
        plain_part = None
        for part in msg.walk():
            if part.get_content_disposition() == "attachment":
                continue
            ctype = part.get_content_type()
            if ctype == "text/html" and html_part is None:
                html_part = _decode_part(part)
            elif ctype == "text/plain" and plain_part is None:
                plain_part = _decode_part(part)
        plain = plain_part or html_to_text(html_part or "")
        return {
            "subject": decode_mime_header(msg.get("Subject")),
            "date": msg.get("Date"),
            "html": html_part or "",
            "text": plain,
            "code": extract_code(html_part or "", plain),
        }


class GalaxiumError(Exception):
    def __init__(self, message, status=None, code=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def load_config(path=None):
    path = path or DEFAULT_CONFIG_PATH
    if not os.path.exists(path):
        raise GalaxiumError("Config not found at %s (copy config.example.json)" % path)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _filename_from_disposition(disposition):
    if not disposition:
        return None
    parts = disposition.split(";")
    for part in parts:
        part = part.strip()
        if part.lower().startswith("filename*="):
            value = part.split("=", 1)[1]
            if "''" in value:
                value = value.split("''", 1)[1]
            return urllib.parse.unquote(value.strip().strip('"'))
        if part.lower().startswith("filename="):
            return part.split("=", 1)[1].strip().strip('"')
    return None


class GalaxiumClient:
    def __init__(self, config_path=None, demo=False):
        self.config_path = config_path or DEFAULT_CONFIG_PATH
        self.config = load_config(self.config_path)
        self.demo = False  # real API only
        self._domain_cache = None
        self._domain_cache_time = 0
        self._msg_cache = {}
        self._rate_limit_until = 0

    # -- transport ---------------------------------------------------------

    def _request(self, method, path, body=None, raw=False):
        import time
        now = time.time()
        if now < self._rate_limit_until:
            wait = max(1, int(self._rate_limit_until - now))
            raise GalaxiumError("The API key exceeded the limit of 30 requests per minute (%ds backoff active)" % wait, status=429, retry_after=wait)

        base = (self.config.get("base_url") or "https://api.galaxium.art").rstrip("/")
        url = base + path
        data = None
        headers = {
            "Accept": "application/json",
            "User-Agent": self.config.get("user_agent") or DEFAULT_USER_AGENT,
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        api_key = (self.config.get("api_key") or "").strip()
        auth = self.config.get("auth", {})
        if api_key:
            headers[auth.get("header", "Authorization")] = "%s%s" % (auth.get("prefix", "Bearer "), api_key)

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.config.get("timeout", 30)) as resp:
                content = resp.read()
                if raw:
                    return content, resp.headers.get("Content-Type", ""), resp.headers.get("Content-Disposition", "")
                if not content:
                    return {}
                return json.loads(content.decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            code = None
            message = detail
            try:
                obj = json.loads(detail)
                code = obj.get("error")
                message = obj.get("message") or detail
            except ValueError:
                pass
            if exc.code == 429 or "limit of 30" in (message or ""):
                self._rate_limit_until = time.time() + 15
            raise GalaxiumError(
                message or ("HTTP %s" % exc.code),
                status=exc.code,
                code=code,
                retry_after=exc.headers.get("Retry-After"),
            )
        except urllib.error.URLError as exc:
            raise GalaxiumError("Cannot reach %s: %s" % (url, exc.reason))
        except ValueError as exc:
            raise GalaxiumError("Invalid JSON from %s: %s" % (url, exc))

    def _hidden(self, name):
        name = name.lower()
        parts = self.config.get("hide_domains") or HIDDEN_DOMAIN_PARTS
        return any(p in name for p in parts)

    # -- API ---------------------------------------------------------------

    def health(self):
        return self._request("GET", "/health")

    def get_domains(self):
        import time
        now = time.time()
        if self._domain_cache and (now - self._domain_cache_time) < 1800:
            return self._domain_cache
        data = self._request("GET", "/v1/domains")
        raw = data.get("domains") if isinstance(data, dict) else data
        out = []
        for item in raw or []:
            if isinstance(item, dict):
                name = item.get("domain") or item.get("name")
                premium = bool(item.get("premium") or item.get("restricted"))
            else:
                name, premium = item, False
            if not name or self._hidden(name):
                continue
            out.append({"domain": name, "premium": premium})
        self._domain_cache = out
        self._domain_cache_time = now
        return out

    def create_inbox(self, domain=None, local_part=None):
        if not domain:
            domains = self.get_domains()
            if domains:
                domain = random.choice(domains).get("domain")
            else:
                domain = "galaxium.art"
        body = {"domain": domain}
        if local_part:
            body["local_part"] = local_part
        return self._request("POST", "/v1/inbox/create", body=body)

    def list_messages(self, email, password, page=0, per_page=10, folder="inbox"):
        path = "/v1/spam" if folder == "spam" else "/v1/inbox"
        return self._request("POST", path, body={
            "email": email, "password": password,
            "page": int(page), "per_page": int(per_page),
        })

    def get_message(self, email, password, message_id, folder="inbox"):
        key = (email, str(message_id))
        if key in self._msg_cache:
            return self._msg_cache[key]
        path = "/v1/spam/message" if folder == "spam" else "/v1/message"
        msg = self._request("POST", path, body={
            "email": email, "password": password, "id": str(message_id),
        })
        self._msg_cache[key] = msg
        return msg

    def fetch_full_body(self, email, password, subject=None, date=None, webmail=None):
        """Full untruncated message via IMAP (API caps body_text at ~20k)."""
        host = self.config.get("imap_host")
        port = self.config.get("imap_port", 993)
        if not host and webmail:
            host = urllib.parse.urlparse(webmail).hostname
        if not host:
            return None
        reader = ImapReader(host, port=port, timeout=self.config.get("imap_timeout", 20))
        return reader.fetch_full(email, password, subject=subject, date=date)

    def search_messages(self, email, password, query, page=0, per_page=10):
        return self._request("POST", "/v1/search", body={
            "email": email, "password": password, "query": query,
            "page": int(page), "per_page": int(per_page),
        })

    def get_attachment(self, email, password, message_id, index, folder="inbox"):
        content, ctype, disposition = self._request("POST", "/v1/attachment", body={
            "email": email, "password": password,
            "id": str(message_id), "attachment_index": int(index),
        }, raw=True)
        return content, ctype, _filename_from_disposition(disposition)

    def count(self):
        return self._request("POST", "/v1/count", body={})

    def uptime(self):
        return self._request("GET", "/v1/uptime")

    def key_age(self):
        return self._request("GET", "/v1/key/age")


# ---------------------------------------------------------------------------
# Local mailbox credential store (server-side; passwords never go to browser)
# ---------------------------------------------------------------------------

class Store:
    def __init__(self, path):
        self.path = path

    def load(self):
        if not os.path.exists(self.path):
            return []
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data.get("inboxes", []) if isinstance(data, dict) else []
        except (ValueError, OSError):
            return []

    def save(self, items):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"inboxes": items}, fh, indent=2)
        os.replace(tmp, self.path)

    def upsert(self, item):
        items = [i for i in self.load() if i.get("email") != item.get("email")]
        items.insert(0, item)
        self.save(items)

    def remove(self, email):
        self.save([i for i in self.load() if i.get("email") != email])

    def find(self, email):
        for item in self.load():
            if item.get("email", "").lower() == (email or "").lower():
                return item
        return None

    def public(self):
        result = []
        for item in self.load():
            result.append({k: item.get(k) for k in ("email", "domain", "webmail", "created")})
        return result
