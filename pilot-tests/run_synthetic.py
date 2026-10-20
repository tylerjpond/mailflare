"""Run a fresh loopback-only fixture. Never accepts an existing data directory."""
import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--fork", action="store_true", help="Verify the minimal send-content fork")
    args = parser.parse_args()
    checkout = args.checkout.resolve(strict=True)
    node = args.node.resolve(strict=True)
    source = Path(__file__).resolve().parent
    if not (checkout / "dist/server.mjs").is_file():
        raise ValueError("Build the upstream Node entrypoint before running the fixture")
    for port in (3317, 2527, 2528):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    runs = checkout / "pilot-maintenance-runs"
    runs.mkdir(exist_ok=True)
    data = Path(tempfile.mkdtemp(prefix="synthetic-", dir=runs))
    # Explicit allowlist: no inherited provider/AI/backup credentials.
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE",
        "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
    }}
    env.update({
        "PATH": os.pathsep.join([str(node.parent), str(Path(sys.executable).parent),
                                str(Path(os.environ.get("SYSTEMROOT", "C:/Windows")) / "System32")]),
        "MAILFLARE_RUNTIME": "node", "NODE_ENV": "production",
        "HOST": "127.0.0.1", "PORT": "3317", "SMTP_INBOUND_HOST": "127.0.0.1",
        "SMTP_INBOUND_PORT": "2527", "SMTP_URL": "smtp://127.0.0.1:2528",
        "DATA_DIR": str(data), "PILOT_DATA_DIR": str(data), "MAILFLARE_CHECKOUT": str(checkout),
        "APP_URL": "http://127.0.0.1:3317", "NEXT_TELEMETRY_DISABLED": "1",
        "MAILFLARE_CLEANUP_BRIDGE": str(source / "synthetic_bridge.py"),
        "MAILFLARE_TEST_FORK": "1" if args.fork else "0",
    })
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with (data / "server.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(node), "dist/server.mjs"], cwd=checkout, env=env,
                                   stdout=log, stderr=log, creationflags=flags)
        try:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError("Pilot server exited; inspect private fixture log")
                try:
                    urllib.request.urlopen("http://127.0.0.1:3317/api/messages", timeout=1).close()
                except urllib.error.HTTPError as error:
                    if error.code == 401:
                        break
                except OSError:
                    pass
                time.sleep(0.25)
            else:
                raise RuntimeError("Pilot readiness timed out")
            password = secrets.token_urlsafe(32)
            request = urllib.request.Request("http://127.0.0.1:3317/api/auth/register", data=json.dumps({
                "domain": "pilot.example.test", "username": "operator", "password": password,
                "resetEmail": "recovery@example.test", "enableSending": True,
            }).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                assert response.status == 200
            (data / "credentials.json").write_text(json.dumps({
                "email": "operator@pilot.example.test", "password": password,
            }), encoding="utf-8")
            for script in ("synthetic-test.mjs", "synthetic-jmap.mjs"):
                subprocess.run([str(node), str(source / script)], cwd=checkout, env=env,
                               check=True, timeout=120, creationflags=flags)
            print(json.dumps({"result": "passed", "evidence_directory": str(data)}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
