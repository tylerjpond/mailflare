import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
const bundle = await build({ entryPoints: ["src/lib/email/quarantine.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { quarantineRawEmail } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture() {
	const bytes = new TextEncoder().encode("Subject: synthetic\r\n\r\nrecover me");
	const objects = new Map([["inbound/test.eml", { bytes, customMetadata: { to: "test@example.test" }, httpMetadata: { contentType: "message/rfc822" } }]]);
	const calls = [];
	const bucket = {
		async get(key) { const row = objects.get(key); return row && { ...row, arrayBuffer: async () => row.bytes }; },
		async head(key) { return objects.get(key) ?? null; },
		async put(key, bytes, options) { calls.push("put"); objects.set(key, { bytes, ...options }); },
		async delete(key) { calls.push("delete"); objects.delete(key); },
	};
	return { env: { BUCKET: bucket }, bucket, objects, calls, bytes };
}
test("quarantine preserves exact MIME and metadata, then removes untracked source", async () => {
	const f = fixture();
	await quarantineRawEmail(f.env, "inbound/test.eml", "no_route");
	assert.equal(f.objects.has("inbound/test.eml"), false);
	const row = f.objects.get("quarantine/inbound/test.eml");
	assert.deepEqual(row.bytes, f.bytes);
	assert.equal(row.customMetadata.reason, "no_route");
	assert.equal(row.customMetadata.to, "test@example.test");
	assert.equal(row.customMetadata.originalKey, "inbound/test.eml");
	assert.deepEqual(f.calls, ["put", "delete"]);
});
test("duplicate delivery does not create or refresh quarantine objects", async () => {
	const f = fixture();
	await quarantineRawEmail(f.env, "inbound/test.eml", "no_route");
	const first = f.objects.get("quarantine/inbound/test.eml");
	await quarantineRawEmail(f.env, "inbound/test.eml", "rejected");
	assert.equal(f.objects.get("quarantine/inbound/test.eml"), first);
	assert.deepEqual(f.calls, ["put", "delete"]);
});
test("failed copy retains source and rejects for queue retry", async () => {
	const f = fixture();
	f.bucket.put = async () => { throw Error("storage unavailable"); };
	await assert.rejects(quarantineRawEmail(f.env, "inbound/test.eml", "no_route"), /storage unavailable/);
	assert.equal(f.objects.has("inbound/test.eml"), true);
	assert.deepEqual(f.calls, []);
});
test("failed delete retries without extending quarantine retention", async () => {
	const f = fixture();
	const remove = f.bucket.delete;
	f.bucket.delete = async () => { throw Error("delete unavailable"); };
	await assert.rejects(quarantineRawEmail(f.env, "inbound/test.eml", "no_route"), /delete unavailable/);
	const first = f.objects.get("quarantine/inbound/test.eml");
	f.bucket.delete = remove;
	await quarantineRawEmail(f.env, "inbound/test.eml", "no_route");
	assert.equal(f.objects.get("quarantine/inbound/test.eml"), first);
	assert.equal(f.objects.has("inbound/test.eml"), false);
	assert.deepEqual(f.calls, ["put", "delete"]);
});
test("reject arbitrary non-inbound storage keys", async () => {
	const f = fixture();
	await assert.rejects(quarantineRawEmail(f.env, "attachments/private", "no_route"), /Invalid inbound/);
	assert.equal(f.objects.size, 1);
});
