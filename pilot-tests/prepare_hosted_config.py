"""Generate an isolated pilot config. Does not provision or deploy anything."""
import argparse
import json
import re
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--database-id", required=True)
    parser.add_argument("--hostname", default="mailpilot.trevellum.ca")
    parser.add_argument("--recipient", required=True, help="One operator-controlled synthetic recipient")
    parser.add_argument("--sender", default="operator@pilot-mail.trevellum.ca")
    args = parser.parse_args()
    uuid.UUID(args.database_id)
    if not re.fullmatch(r"mailpilot(?:-[a-z0-9]+)?\.trevellum\.ca", args.hostname):
        raise ValueError("Only a dedicated mailpilot hostname is allowed")
    if not re.fullmatch(r"[a-zA-Z0-9._+-]+@pilot-mail\.trevellum\.ca", args.sender):
        raise ValueError("Sender must be in the isolated pilot mail subdomain")
    if not re.fullmatch(r"[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", args.recipient):
        raise ValueError("One explicit recipient address is required")
    checkout = args.checkout.resolve(strict=True)
    base = checkout / "wrangler.jsonc"
    # The pinned upstream file has trailing commas but no JSONC comments.
    config = json.loads(re.sub(r",(\s*[}\]])", r"\1", base.read_text(encoding="utf-8")))
    name = "merrivanta-mailflare-pilot"
    config.update({
        "name": name, "workers_dev": False, "preview_urls": False,
        "keep_vars": False,
        "routes": [{"pattern": args.hostname, "custom_domain": True}],
        "vars": {"APP_URL": "https://" + args.hostname, "CF_EMAIL_WORKER_NAME": name},
        "observability": {"enabled": False},
    })
    config.pop("ai", None)
    config["send_email"] = [{
        "name": "EMAIL", "remote": False,
        "allowed_sender_addresses": [args.sender],
        "allowed_destination_addresses": [args.recipient],
    }]
    config["services"] = [{"binding": "WORKER_SELF_REFERENCE", "service": name}]
    config["d1_databases"] = [{
        "binding": "DB", "database_name": name, "database_id": args.database_id,
        "migrations_dir": "drizzle/migrations",
    }]
    config["r2_buckets"] = [{"binding": "BUCKET", "bucket_name": name + "-raw"}]
    for producer in config["queues"]["producers"]:
        producer["queue"] = name + "-" + producer["queue"].removeprefix("mailflare-")
    for consumer in config["queues"]["consumers"]:
        consumer["queue"] = name + "-" + consumer["queue"].removeprefix("mailflare-")
    destination = checkout / "wrangler.pilot.jsonc"
    if destination.exists():
        raise FileExistsError("Review/remove the previous generated config explicitly")
    destination.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"config": str(destination), "deployed": False,
                      "requires_access_gate_before_deploy": True}))


if __name__ == "__main__":
    main()
