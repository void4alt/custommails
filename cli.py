#!/usr/bin/env python3
"""Zeltcon Checker command-line client (real API)."""

import argparse
import datetime
import json
import os
import sys

import galaxium


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def make_store(client):
    return galaxium.Store(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       client.config.get("inbox_store", "inboxes.json")))


def creds(store, email):
    item = store.find(email)
    if not item:
        raise galaxium.GalaxiumError("No stored mailbox for %s (create one with `new`)" % email)
    return item


def cmd_health(args, client, store):
    out({"health": client.health(), "base_url": client.config.get("base_url"),
         "has_key": bool((client.config.get("api_key") or "").strip())})


def cmd_meta(args, client, store):
    out({"count": client.count(), "key_age": client.key_age(), "uptime": client.uptime()})


def cmd_domains(args, client, store):
    out(client.get_domains())


def cmd_new(args, client, store):
    result = client.create_inbox(domain=args.domain, local_part=args.name)
    email = result.get("email")
    item = {
        "email": email,
        "password": result.get("password"),
        "webmail": result.get("webmail"),
        "domain": email.split("@")[-1] if email and "@" in email else args.domain,
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    store.upsert(item)
    out({"email": email, "password": item["password"], "webmail": item["webmail"]})


def cmd_inboxes(args, client, store):
    out(store.public())


def cmd_list(args, client, store):
    item = creds(store, args.email)
    out(client.list_messages(item["email"], item["password"], page=args.page,
                             per_page=args.per_page, folder="spam" if args.spam else "inbox"))


def cmd_read(args, client, store):
    item = creds(store, args.email)
    msg = client.get_message(item["email"], item["password"], args.id,
                             folder="spam" if args.spam else "inbox")
    body = msg.get("body_text") or ""
    looks_html = body.lstrip()[:15].lower().startswith("<!doctype") or "<html" in body[:300].lower()
    if looks_html and not msg.get("body_html"):
        msg["body_html"] = body
        msg["body_text"] = galaxium.html_to_text(body)
    if not args.no_full and (msg.get("body_truncated") or looks_html):
        try:
            full = client.fetch_full_body(item["email"], item["password"],
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
    if not msg.get("code"):
        msg["code"] = galaxium.extract_code(msg.get("body_html") or "", msg.get("body_text") or "")
    if not args.raw:
        msg.pop("body_html", None)
    out(msg)


def cmd_search(args, client, store):
    item = creds(store, args.email)
    out(client.search_messages(item["email"], item["password"], args.query,
                               page=args.page, per_page=args.per_page))


def cmd_attach(args, client, store):
    item = creds(store, args.email)
    content, ctype, name = client.get_attachment(item["email"], item["password"], args.id,
                                                 args.index, folder="spam" if args.spam else "inbox")
    dest = args.out or name or ("attachment-%s" % args.index)
    with open(dest, "wb") as fh:
        fh.write(content)
    out({"saved": os.path.abspath(dest), "content_type": ctype, "bytes": len(content)})


def cmd_forget(args, client, store):
    store.remove(args.email)
    out({"forgot": args.email})


def cmd_reveal(args, client, store):
    item = creds(store, args.email)
    out({"email": item["email"], "password": item.get("password"), "webmail": item.get("webmail")})


def build_parser():
    parser = argparse.ArgumentParser(prog="galaxium", description="Galaxium Mail CLI")
    parser.add_argument("--config", help="path to config.json")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("health")
    sub.add_parser("meta", help="count / key age / uptime")
    sub.add_parser("domains")
    sub.add_parser("inboxes")

    p = sub.add_parser("new")
    p.add_argument("--domain")
    p.add_argument("--name", help="local part (optional)")

    p = sub.add_parser("list")
    p.add_argument("email")
    p.add_argument("--page", type=int, default=0)
    p.add_argument("--per-page", type=int, default=10)
    p.add_argument("--spam", action="store_true")

    p = sub.add_parser("read")
    p.add_argument("email")
    p.add_argument("id")
    p.add_argument("--spam", action="store_true")
    p.add_argument("--no-full", action="store_true", help="skip IMAP full-body fetch")
    p.add_argument("--raw", action="store_true", help="include full HTML")

    p = sub.add_parser("search")
    p.add_argument("email")
    p.add_argument("query")
    p.add_argument("--page", type=int, default=0)
    p.add_argument("--per-page", type=int, default=10)

    p = sub.add_parser("attach")
    p.add_argument("email")
    p.add_argument("id")
    p.add_argument("index", type=int)
    p.add_argument("-o", "--out")
    p.add_argument("--spam", action="store_true")

    p = sub.add_parser("forget")
    p.add_argument("email")

    p = sub.add_parser("reveal")
    p.add_argument("email")

    return parser


COMMANDS = {
    "health": cmd_health, "meta": cmd_meta, "domains": cmd_domains,
    "new": cmd_new, "inboxes": cmd_inboxes, "list": cmd_list,
    "read": cmd_read, "search": cmd_search, "attach": cmd_attach,
    "forget": cmd_forget, "reveal": cmd_reveal,
}


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 1
    try:
        client = galaxium.GalaxiumClient(config_path=args.config)
    except galaxium.GalaxiumError as exc:
        print("config error: %s" % exc, file=sys.stderr)
        return 2
    store = make_store(client)
    try:
        COMMANDS[args.command](args, client, store)
    except galaxium.GalaxiumError as exc:
        print("error: %s" % (exc), file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
