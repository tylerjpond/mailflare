/**
 * Keep undeliverable raw mail discoverable without acknowledging an untracked
 * object. Operators must configure expiry on the quarantine/ storage prefix.
 * Copy before delete: storage failures throw so the queue retries safely.
 */
export async function quarantineRawEmail(
	env: CloudflareEnv,
	rawR2Key: string,
	reason: "no_route" | "rejected" | "forward_without_mailbox" | "missing_mailbox",
): Promise<void> {
	// Only inbound objects belong to this flow; never move arbitrary bucket keys.
	if (!rawR2Key.startsWith("inbound/")) throw new Error("Invalid inbound raw key");
	const raw = await env.BUCKET.get(rawR2Key);
	if (!raw) return; // A prior delivery already moved or deleted this object.
	const key = `quarantine/${rawR2Key}`;
	if (!(await env.BUCKET.head(key))) {
		await env.BUCKET.put(key, await raw.arrayBuffer(), {
			httpMetadata: raw.httpMetadata,
			customMetadata: {
				...raw.customMetadata,
				reason,
				quarantinedAt: new Date().toISOString(),
				originalKey: rawR2Key,
			},
		});
	}
	// Retrying a failed delete does not rewrite the quarantine object or extend
	// its lifecycle deadline. Never acknowledge a failed copy or failed delete.
	await env.BUCKET.delete(rawR2Key);
}
