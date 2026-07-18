// Runnable check for the non-trivial logic (ids, claim guards, moves).
// Run: node selfcheck.ts
import assert from "node:assert";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "./core.ts";

const root = mkdtempSync(join(tmpdir(), "agent-tasks-"));
try {
	const a = core.create(root, "Alpha task", "why a", []);
	const b = core.create(root, "Beta task", "", [1]);
	assert.equal(a.id, "001");
	assert.equal(b.id, "002");
	assert.deepEqual(b.deps, ["1"]);

	core.claim(root, 1, "agent-a");
	assert.throws(() => core.claim(root, 1, "agent-b"), /already claimed/);
	assert.throws(() => core.claim(root, 2, "agent-a"), /already holds #001/);
	assert.throws(() => core.drop(root, 1, "agent-b"), /claimed by agent-a/);
	assert.throws(() => core.done(root, 1, "agent-b"), /claimed by agent-a/);

	// Losing a claim race: the file was moved to claimed/ before our rename.
	const c = core.create(root, "Gamma task", "", []);
	renameSync(join(root, "tasks/open", c.file), join(root, "tasks/claimed", c.file));
	assert.throws(() => core.claim(root, 3, "agent-c"), /already claimed/);

	core.done(root, 1, "agent-a");
	core.claim(root, 2, "agent-b");
	core.drop(root, 2, "agent-b");
	assert.equal(core.list(root, "open").length, 1);
	core.claim(root, 2, "agent-b");

	assert.equal(core.list(root, "done").length, 1);
	assert.equal(core.list(root, "claimed")[0].claimedBy, "agent-b");
	assert.ok(core.show(root, 2).includes("## Why"));
	console.log("selfcheck OK");
} finally {
	rmSync(root, { recursive: true, force: true });
}
