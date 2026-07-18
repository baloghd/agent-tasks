/**
 * File-based task store. Tasks are markdown files in tasks/{open,claimed,done}/.
 * Status is the directory; claiming is an atomic rename. Everything is plain
 * text committed to git, so any number of agents (and humans) share the board.
 *
 * No pi imports in here on purpose: this file is unit-testable with plain node.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DIRS = ["open", "claimed", "done"] as const;
export type Status = (typeof DIRS)[number];

export interface Task {
	id: string;
	file: string;
	status: Status;
	path: string;
	title: string;
	epic: string;
	claimedBy: string;
	claimedAt: string;
	deps: string[];
	created: string;
}

const ROOT = "tasks";

export function ensure(root: string): void {
	for (const d of DIRS) mkdirSync(join(root, ROOT, d), { recursive: true });
}

export function slug(title: string): string {
	const s = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\x00-\x7F]/g, "");
	return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 50) || "task";
}

function field(fm: string, key: string): string {
	const m = fm.match(new RegExp(`^${key}: *(.*)$`, "m"));
	return m ? m[1].trim() : "";
}

export function parse(path: string, status: Status): Task {
	const text = readFileSync(path, "utf8");
	const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const file = basename(path);
	const deps = field(fm, "deps").replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
	return {
		id: file.slice(0, 3),
		file,
		status,
		path,
		title: field(fm, "title"),
		epic: field(fm, "epic"),
		claimedBy: field(fm, "claimed_by"),
		claimedAt: field(fm, "claimed_at"),
		deps,
		created: field(fm, "created"),
	};
}

export function list(root: string, status?: Status, epic?: string): Task[] {
	const dirs: Status[] = status ? [status] : [...DIRS];
	const out: Task[] = [];
	for (const d of dirs) {
		const dir = join(root, ROOT, d);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).sort()) {
			if (f.endsWith(".md")) out.push(parse(join(dir, f), d));
		}
	}
	return epic && epic !== "*" ? out.filter((t) => t.epic === epic) : out;
}

export function epics(root: string): { name: string; count: number; claimed: number; done: number }[] {
	const all = list(root);
	const map = new Map<string, { count: number; claimed: number; done: number }>();
	for (const t of all) {
		if (!t.epic) continue;
		const e = map.get(t.epic) ?? { count: 0, claimed: 0, done: 0 };
		e.count++;
		if (t.status === "claimed") e.claimed++;
		if (t.status === "done") e.done++;
		map.set(t.epic, e);
	}
	return [...map.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.count - a.count);
}

export function find(root: string, id: number | string): Task {
	const tid = String(id).padStart(3, "0");
	for (const t of list(root)) if (t.id === tid) return t;
	throw new Error(`task #${tid} not found`);
}

function stamp(path: string, fields: Record<string, string>): void {
	let text = readFileSync(path, "utf8");
	for (const [k, v] of Object.entries(fields)) {
		text = text.replace(new RegExp(`^${k}:.*$`, "m"), `${k}: ${v}`);
	}
	writeFileSync(path, text);
}

export function create(root: string, title: string, why: string, deps: number[], epic = ""): Task {
	ensure(root);
	const used = list(root).map((t) => parseInt(t.id, 10));
	let nid = used.length ? Math.max(...used) + 1 : 1;
	const text = `---\ntitle: ${title}\nclaimed_by: \nclaimed_at: \ndeps: [${deps.join(", ")}]\nepic: ${epic}\ncreated: ${new Date().toISOString()}\n---\n\n## Why\n\n${why}\n\n## Acceptance\n\n- [ ] \n`;
	// ponytail: O_EXCL create is the id race control; a losing racer just bumps.
	while (true) {
		const path = join(root, ROOT, "open", `${String(nid).padStart(3, "0")}-${slug(title)}.md`);
		try {
			writeFileSync(path, text, { flag: "wx" });
			return parse(path, "open");
		} catch (e: any) {
			if (e.code === "EEXIST") {
				nid++;
				continue;
			}
			throw e;
		}
	}
}

function move(t: Task, target: Status): Task {
	const dst = join(dirname(dirname(t.path)), target, t.file);
	// ponytail: rename is atomic on one filesystem; this IS the claim lock.
	renameSync(t.path, dst);
	return parse(dst, target);
}

export function claim(root: string, id: number, agent: string): Task {
	const t = find(root, id);
	if (t.status === "done") throw new Error(`#${t.id} is done`);
	if (t.status === "claimed") throw new Error(`#${t.id} already claimed by ${t.claimedBy || "someone"}`);
	// ponytail: one active claim per agent, enforced; delete this check if it gets in the way.
	const held = list(root, "claimed").find((x) => x.claimedBy === agent);
	if (held) throw new Error(`${agent} already holds #${held.id} - drop or finish it first`);
	let out: Task;
	try {
		out = move(t, "claimed");
	} catch {
		throw new Error(`lost the race: #${t.id} was just claimed; list again`);
	}
	stamp(out.path, { claimed_by: agent, claimed_at: new Date().toISOString() });
	return parse(out.path, "claimed");
}

export function drop(root: string, id: number, agent: string): Task {
	const t = find(root, id);
	if (t.status !== "claimed") throw new Error(`#${t.id} is not claimed`);
	if (t.claimedBy && t.claimedBy !== agent) throw new Error(`#${t.id} is claimed by ${t.claimedBy}, not ${agent}`);
	const out = move(t, "open");
	stamp(out.path, { claimed_by: "", claimed_at: "" });
	return parse(out.path, "open");
}

export function done(root: string, id: number, agent: string): Task {
	const t = find(root, id);
	if (t.status === "done") throw new Error(`#${t.id} already done`);
	if (t.status === "claimed" && t.claimedBy && t.claimedBy !== agent)
		throw new Error(`#${t.id} is claimed by ${t.claimedBy}, not ${agent}`);
	return move(t, "done");
}

export function show(root: string, id: number): string {
	return readFileSync(find(root, id).path, "utf8");
}
