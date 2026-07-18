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

	// Epic tests
	const ei = core.create(root, "Init: refactor auth", "epic description", []);
	const e1 = core.create(root, "Add login page", "", [1], "refactor-auth");
	const e2 = core.create(root, "Add logout page", "", [1], "refactor-auth");
	assert.equal(ei.id, "004");
	assert.equal(ei.epic, "");
	assert.equal(e1.epic, "refactor-auth");
	assert.equal(e2.epic, "refactor-auth");

	const all = core.list(root);
	assert.equal(all.filter((t) => t.epic === "refactor-auth").length, 2);
	assert.equal(all.filter((t) => t.epic).length, 2);

	// epics() aggregate
	const eps = core.epics(root);
	assert.equal(eps.length, 1);
	assert.equal(eps[0].name, "refactor-auth");
	assert.equal(eps[0].count, 2);
	assert.equal(eps[0].done, 0);

	console.log("selfcheck OK");
} finally {
	rmSync(root, { recursive: true, force: true });
}
