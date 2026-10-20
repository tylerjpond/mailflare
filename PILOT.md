# Merrivanta Labs synthetic Mailflare pilot

Based on hieunc229/mailflare commit
`2ecaa69c3456326c24544c99ad47091e7f0cee84`, under the original AGPL-3.0 license.
This is an experimental synthetic-mail installation, not live support routing.

The fork updates the locked build dependencies and makes two small application
changes: completed sends discard their duplicate job payload after delivery and
bookkeeping succeed, and send audits omit recipient/subject content. The original
sent message remains available for the operator's support retention policy.
Failed or uncertain deliveries retain their payload for reconciliation. Existing
historical rows are not retroactively changed. Queue job identity/status remains,
so repeated delivery of a completed job is ignored.

The sidebar links to this source. The dashboard update workflow intentionally
fails instead of replacing the tree. GitHub Actions is disabled for the fork.
Review and merge upstream commits into `codex/synthetic-pilot`, review database
migrations and dependencies, then rerun delivery, isolation, failure, deletion
and no-replay acceptance before deployment. Do not reset this branch to upstream.

The unresolved braces advisory is in build/lint dependencies; inspect the emitted
Worker and its imports on every dependency update. Do not build unreviewed code
with deployment secrets. This is not a claim that the dependency audit is clean.

## Hosted pilot boundary

- Use fresh, dedicated D1, R2 and queue resources, with a separate test subdomain.
- Protect HTTP access before exposing first-run registration; disable workers.dev
  and preview URLs when using a Cloudflare Access protected custom hostname.
- Use only operator-controlled synthetic senders/recipients. Do not change
  existing Trevellum MX records or support routing.
- Do not configure AI, update tokens, external webhooks, forwarding or automated
  backups. No backup/restore experiment may restore into an active pilot.
- Keep an explicit teardown date and inventory. D1 Time Travel and provider
  delivery records have separate recovery/retention windows; logical deletion
  does not erase those immediately.
- Verify real D1/R2 delivery, replies, cross-user denial, deletion and a duplicate
  queue event on the deployed revision before considering live adoption.
- Separate projects should use separate instances/resources for now. Shared
  mailboxes are license-gated upstream; this fork does not bypass that check.

The fork does not implement automatic case resolution or the 12-month support
deadline. Those govern the retained message, not this disposable send-job copy.

## Reproduce acceptance

Use Node 24.22.0, install the lockfile, run the migration-bundle generator,
build Next with `MAILFLARE_RUNTIME=node`, and run `scripts/build-server.mjs`.
Then run:

```text
python pilot-tests/run_synthetic.py --checkout . --node ABSOLUTE_NODE_PATH --fork
```

The fixture accepts no existing database, supplies no provider credentials, uses
loopback SMTP, and stops the server when finished. Failed-send records are
intentionally retained in the disposable fixture. Do not upload fixture output
directories; they contain random local credentials and synthetic message bodies.

For Cloudflare, `pilot-tests/prepare_hosted_config.py` creates an exclusive
`wrangler.pilot.jsonc` using explicit database ID and recipient arguments.
Set `MAILFLARE_WRANGLER_CONFIG=./wrangler.pilot.jsonc` before `npm run build`.
The generated config restricts the email binding to one pilot sender/recipient,
disables workers.dev/preview URLs, omits AI, and names separate resources.
It does not create Access policies or resources: provision and verify those
before deployment. The all-zero database ID used in local dry-runs is not real.
Then inspect the exact emitted Worker with:

```text
node pilot-tests/check_worker_reachability.mjs .
```

Review any nonliteral import manually and record the artifact hash. Current
vinext has one fixed React development-renderer import, unreachable under its
production runtime check and unrelated to request or email input. This does not
justify allowing arbitrary future dynamic imports.
