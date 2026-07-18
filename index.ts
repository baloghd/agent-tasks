/**
 * agent-tasks - git-friendly task tracker for parallel pi agents.
 *
 * Tasks are plain markdown in tasks/{open,claimed,done}/, committed to git.
 * Status = directory. Claim = atomic rename, so two agents can't take the
 * same task. The standing rules below ride in the system prompt via
 * promptGuidelines, so they survive compaction and need no AGENTS.md.
 *
 * Install via `pi install git:github.com/baloghd/agent-tasks`.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as core from "./core.ts";

const TaskParams = Type.Object({
	action: StringEnum(["list", "new", "claim", "drop", "done", "show", "epics"] as const),
	id: Type.Optional(Type.Number({ description: "Task id (claim, drop, done, show)" })),
	title: Type.Optional(Type.String({ description: "Task title (new)" })),
	why: Type.Optional(Type.String({ description: "Context for a cold agent: why this matters, file pointers (new)" })),
	deps: Type.Optional(Type.Array(Type.Number(), { description: "Ids of related/overlapping tasks (new)" })),
	epic: Type.Optional(Type.String({ description: "Epic/initiative name (new); filter by epic when list; * with list shows all epics" })),
	acceptance: Type.Optional(Type.String({ description: "Done criteria, one per line or as markdown checklist (new)" })),
	status: Type.Optional(StringEnum(["open", "claimed", "done"] as const)),
	agent: Type.Optional(Type.String({ description: "Your unique handle. Defaults to your session id." })),
});

function need(id: number | undefined): number {
	if (id === undefined) throw new Error("id required");
	return id;
}

function fmt(t: core.Task): string {
	const who = t.claimedBy ? ` [${t.claimedBy}]` : "";
	const deps = t.deps.length ? ` deps:[${t.deps.join(",")}]` : "";
	const ep = t.epic ? ` (${t.epic})` : "";
	return `${t.status.padEnd(8)} #${t.id} ${t.title}${who}${deps}${ep}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Manage project tasks: git-committed markdown files in tasks/, shared by every agent working this repo. " +
			"Status is the directory (open/claimed/done); claiming is atomic, so parallel agents cannot take the same task. " +
			"Actions: list (status?, epic?), new (title, why?, deps?, epic?, acceptance?), claim (id, agent?), drop (id, agent?), done (id, agent?), show (id), epics. " +
			"Epics: use epic=NAME on any task to group it; list epic=* shows all epics with counts.",
		promptSnippet: "Track and claim project tasks in tasks/ (git-committed, shared across agents)",
		promptGuidelines: [
			"Use the task tool with action list at session start and before starting new work; tasks/ is the shared board for every agent on this repo.",
			"Claim before you work: task action=claim with your handle. Never start or edit a task claimed by another agent; pick a different one or create a new one.",
			'Before recommending follow-up work to the user, create each item with task action=new and present the ids. Never ask "should I do a, b or c?" without one task per option.',
			"When follow-ups overlap, pass the overlapping ids as deps to task action=new and explain the overlap in why, so nobody redoes it.",
			"Group related tasks under an epic: task action=new with epic=NAME for the parent initiative, then epic=NAME on child tasks. Use task action=epics to see all groups.",
			"Write task why/acceptance for a cold reader: another agent must be able to pick the task up with zero chat history. When porting from an existing document, include the concrete acceptance criteria in the acceptance param.",
			"If scope grows mid-task, create the extra work with task action=new instead of silently expanding the current task.",
			"Finish with task action=done and reference the task id in your commit message.",
		],
		parameters: TaskParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = params.agent ?? ctx.sessionManager.getSessionId().slice(0, 8);
			try {
				switch (params.action) {
					case "list": {
						const tasks = core.list(ctx.cwd, params.status, params.epic);
						const text = tasks.length
							? tasks.map(fmt).join("\n")
							: "No tasks. Create one with task action=new.";
						return { content: [{ type: "text", text }] };
					}
					case "new": {
						if (!params.title) throw new Error("title required for new");
						const t = core.create(ctx.cwd, params.title, params.why ?? "", params.deps ?? [], params.epic ?? "", params.acceptance ?? "");
						return {
							content: [
								{
									type: "text",
									text: `Created #${t.id} (${t.file}). Why ${params.why ? "set" : "empty"}, acceptance ${params.acceptance ? "set" : "empty"}.`,
								},
							],
						};
					}
					case "claim": {
						const t = core.claim(ctx.cwd, need(params.id), agent);
						return { content: [{ type: "text", text: `Claimed #${t.id} for ${agent}` }] };
					}
					case "drop": {
						const t = core.drop(ctx.cwd, need(params.id), agent);
						return { content: [{ type: "text", text: `Dropped #${t.id} back to open` }] };
					}
					case "done": {
						const t = core.done(ctx.cwd, need(params.id), agent);
						return { content: [{ type: "text", text: `#${t.id} done` }] };
					}
					case "show":
						return { content: [{ type: "text", text: core.show(ctx.cwd, need(params.id)) }] };
					case "epics": {
						const es = core.epics(ctx.cwd);
						if (!es.length)
							return { content: [{ type: "text", text: "No epics defined. Use epic=NAME when creating tasks." }] };
						const text = es
							.map(
								(e) =>
									`${e.name.padEnd(24)} ${e.count} tasks, ${e.claimed} claimed, ${e.done} done`,
							)
							.join("\n");
						return { content: [{ type: "text", text }] };
					}
				}
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	// /tasks - the board, for the human coordinating parallel agents.
	pi.registerCommand("tasks", {
		description: "Show the task board (open / claimed / done)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tasks requires interactive mode", "error");
				return;
			}
			const tasks = core.list(ctx.cwd);
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new BoardComponent(tasks, theme, done));
		},
	});
}

const statusRank: Record<core.Status, number> = { open: 0, claimed: 1, done: 2 };
function taskSort(tasks: core.Task[]): core.Task[] {
	return [...tasks].sort((a, b) => {
		const r = statusRank[a.status] - statusRank[b.status];
		return r !== 0 ? r : parseInt(a.id, 10) - parseInt(b.id, 10);
	});
}

class BoardComponent {
	private tasks: core.Task[];
	private theme: Theme;
	private onClose: () => void;

	constructor(tasks: core.Task[], theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = ["", ` ${th.fg("accent", th.bold(" Tasks "))}`, ""];
		if (this.tasks.length === 0) {
			lines.push(`  ${th.fg("dim", "No tasks yet. The agent creates them with the task tool.")}`);
		} else {
			// group by epic, ungrouped at the end
			const byEpic = new Map<string, core.Task[]>();
			const noEpic: core.Task[] = [];
			for (const t of this.tasks) {
				if (t.epic) {
					const g = byEpic.get(t.epic) ?? [];
					g.push(t);
					byEpic.set(t.epic, g);
				} else {
					noEpic.push(t);
				}
			}
			for (const name of [...byEpic.keys()].sort()) {
				const tasks = byEpic.get(name)!;
				lines.push(` ${th.fg("accent", name)}  ${th.fg("dim", `${tasks.length} tasks`)}`);
				for (const t of taskSort(tasks)) lines.push(this.taskLine(t, width));
				lines.push("");
			}
			if (noEpic.length) {
				lines.push(` ${th.fg("muted", "UNGROUPED")}`);
				for (const t of taskSort(noEpic)) lines.push(this.taskLine(t, width));
				lines.push("");
			}
		}
		lines.push(`  ${th.fg("dim", "Files: tasks/{open,claimed,done}/ - escape to close")}`, "");
		return lines.map((l) => truncateToWidth(l, width));
	}

	private taskLine(t: core.Task, width: number): string {
		const th = this.theme;
		const icon = t.status === "claimed" ? "→" : t.status === "done" ? "✓" : "○";
		const iconColor = t.status === "done" ? "dim" : t.status === "claimed" ? "accent" : "text";
		let line = `  ${th.fg(iconColor, icon)} ${th.fg("accent", `#${t.id}`)} ${t.title}`;
		if (t.claimedBy) {
			const ageH = t.claimedAt
				? Math.max(0, Math.round((Date.now() - Date.parse(t.claimedAt)) / 360000) / 10)
				: 0;
			line += th.fg("muted", ` [${t.claimedBy}, ${ageH}h]`);
		}
		if (t.deps.length) line += th.fg("dim", ` deps:[${t.deps.join(",")}]`);
		return line;
	}

	invalidate(): void {}
}
