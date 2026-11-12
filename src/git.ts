import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, type Config, type ProjectConfig } from "./config.ts";
import { must, run, sh, tail } from "./shell.ts";

/** Scratch folder inside each worktree for screenshots and reports. Never committed. */
export const SCRATCH = ".orchestrator";

// Worktrees share their repo's refs, and overlapping fetches fail with "cannot lock ref". Run them one at a time.
let fetchQueue: Promise<unknown> = Promise.resolve();
function fetchOrigin(cwd: string, ...refs: string[]): Promise<string> {
    const next = fetchQueue.then(() => must("git", ["fetch", "--quiet", "origin", ...refs], { cwd }));
    fetchQueue = next.catch(() => {});
    return next;
}

export class Git {
    constructor(private config: Config) {}

    repo(project: ProjectConfig): string {
        return expandHome(project.repoPath);
    }

    worktreePath(project: ProjectConfig, identifier: string): string {
        return join(expandHome(this.config.paths.worktrees), project.name, identifier);
    }

    private async remoteBranchExists(repo: string, branch: string): Promise<boolean> {
        const r = await run("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: repo });
        return r.code === 0;
    }

    /**
     * Makes sure the branch a PR will target exists on origin. The repo's base branch must already exist;
     * a feature branch from a Branch label is cut from the base branch the first time it's used.
     */
    async ensureTargetBranch(project: ProjectConfig, target: string): Promise<void> {
        const repo = this.repo(project);
        if (await this.remoteBranchExists(repo, target)) return;
        if (target === project.baseBranch) {
            throw new Error(`${project.name}: base branch "${target}" doesn't exist on origin. Create it: git push origin main:${target}`);
        }
        if (!(await this.remoteBranchExists(repo, project.baseBranch))) {
            throw new Error(`${project.name}: can't cut "${target}" because base branch "${project.baseBranch}" doesn't exist on origin either.`);
        }
        await fetchOrigin(repo, project.baseBranch);
        await must("git", ["push", "--quiet", "origin", `refs/remotes/origin/${project.baseBranch}:refs/heads/${target}`], { cwd: repo });
    }

    /** Returns the worktree for a ticket, creating it (and running project setup) if needed. New branches start from `base`. */
    async ensureWorktree(project: ProjectConfig, identifier: string, branch: string, base: string): Promise<string> {
        const repo = this.repo(project);
        const path = this.worktreePath(project, identifier);
        await fetchOrigin(repo);
        await this.ignoreScratch(repo);

        if (existsSync(join(path, ".git"))) {
            if (await this.remoteBranchExists(repo, branch)) {
                await run("git", ["merge", "--ff-only", "--quiet", `origin/${branch}`], { cwd: path });
            }
            return path;
        }

        await mkdir(join(path, ".."), { recursive: true });
        const local = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo })).code === 0;
        if (local) {
            await must("git", ["worktree", "add", path, branch], { cwd: repo });
        } else if (await this.remoteBranchExists(repo, branch)) {
            await must("git", ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], { cwd: repo });
        } else {
            await must("git", ["worktree", "add", "--no-track", "-b", branch, path, `origin/${base}`], { cwd: repo });
        }

        for (const cmd of project.setup) {
            const r = await sh(cmd.replaceAll("{repo}", repo), { cwd: path, timeoutMs: 20 * 60_000 });
            if (r.code !== 0) throw new Error(`Worktree setup failed at \`${cmd}\`:\n${tail(r.stderr || r.stdout, 30)}`);
        }
        return path;
    }

    private async ignoreScratch(repo: string): Promise<void> {
        const common = await must("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo });
        const exclude = join(common, "info", "exclude");
        const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
        if (!current.split("\n").includes(`${SCRATCH}/`)) {
            await mkdir(join(common, "info"), { recursive: true });
            await appendFile(exclude, `\n${SCRATCH}/\n`);
        }
    }

    /** A read-only checkout of a branch tip, for agents that only look (QA). Recreated fresh each time. */
    async snapshotWorktree(project: ProjectConfig, name: string, branch: string): Promise<string> {
        const repo = this.repo(project);
        const path = this.worktreePath(project, name);
        await fetchOrigin(repo);
        await run("git", ["worktree", "remove", "--force", path], { cwd: repo });
        await mkdir(join(path, ".."), { recursive: true });
        await must("git", ["worktree", "add", "--detach", path, `origin/${branch}`], { cwd: repo });
        return path;
    }

    async removeSnapshot(project: ProjectConfig, name: string): Promise<void> {
        await run("git", ["worktree", "remove", "--force", this.worktreePath(project, name)], { cwd: this.repo(project) });
    }

    /** Commits anything the agent left uncommitted. Returns true if a commit was made. */
    async commitAll(path: string, message: string): Promise<boolean> {
        await must("git", ["add", "-A"], { cwd: path });
        const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: path });
        if (staged.code === 0) return false;
        await must("git", ["commit", "--quiet", "-m", message], { cwd: path });
        return true;
    }

    async commitsAhead(path: string, base: string): Promise<number> {
        return Number(await must("git", ["rev-list", "--count", `origin/${base}..HEAD`], { cwd: path }));
    }

    async headSha(path: string): Promise<string> {
        return must("git", ["rev-parse", "HEAD"], { cwd: path });
    }

    async push(path: string, branch: string): Promise<void> {
        await must("git", ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: path });
    }

    /** Merges the latest base into the branch. Returns false if there are conflicts left for the agent. */
    async mergeBase(path: string, base: string): Promise<boolean> {
        await fetchOrigin(path, base);
        const r = await run("git", ["merge", "--no-edit", `origin/${base}`], { cwd: path });
        return r.code === 0;
    }

    async diffStat(path: string, base: string): Promise<string> {
        return must("git", ["diff", "--stat", `origin/${base}...HEAD`], { cwd: path });
    }

    /** Removes a ticket's worktree and the local branch it has checked out. */
    async removeWorktree(project: ProjectConfig, identifier: string): Promise<void> {
        const repo = this.repo(project);
        const path = this.worktreePath(project, identifier);
        const head = existsSync(path) ? await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path }) : undefined;
        await run("git", ["worktree", "remove", "--force", path], { cwd: repo });
        if (head?.code === 0) await run("git", ["branch", "-D", head.stdout.trim()], { cwd: repo });
    }

    /** Folder names under a project's worktree root. */
    async worktreeFolders(project: ProjectConfig): Promise<string[]> {
        const entries = await readdir(join(expandHome(this.config.paths.worktrees), project.name), { withFileTypes: true }).catch(() => []);
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
}
