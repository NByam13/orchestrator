import { spawn } from "node:child_process";

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface RunOptions {
    cwd: string;
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}

const MAX_BUFFER = 20 * 1024 * 1024;

/** Runs a command. Never throws on a non-zero exit; check `code`. */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolvePromise) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  child.kill("SIGTERM");
                  setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
              }, opts.timeoutMs)
            : undefined;
        child.stdout.on("data", (d: Buffer) => {
            if (stdout.length < MAX_BUFFER) stdout += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
            if (stderr.length < MAX_BUFFER) stderr += d.toString();
        });
        child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            resolvePromise({ code: 127, stdout, stderr: stderr + String(err), timedOut });
        });
        child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            resolvePromise({ code: code ?? 1, stdout, stderr, timedOut });
        });
        child.stdin.end(opts.input ?? "");
    });
}

/** Runs a shell string (for config-supplied commands like gates). */
export function sh(command: string, opts: RunOptions): Promise<RunResult> {
    return run("/bin/bash", ["-lc", command], opts);
}

/** Runs and throws with the output if the command fails. */
export async function must(cmd: string, args: string[], opts: RunOptions): Promise<string> {
    const r = await run(cmd, args, opts);
    if (r.code !== 0) {
        throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}):\n${tail(r.stderr || r.stdout, 40)}`);
    }
    return r.stdout.trim();
}

export function tail(text: string, lines: number): string {
    return text.trimEnd().split("\n").slice(-lines).join("\n");
}
