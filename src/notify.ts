import { log } from "./log.ts";

/** Optional push alongside Linear's own notification. Discord webhook or ntfy.sh topic URL. */
export async function notify(title: string, body: string, link?: string): Promise<void> {
    const url = process.env.NOTIFY_WEBHOOK_URL;
    if (!url) return;
    try {
        if (url.includes("discord.com/api/webhooks")) {
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: `**${title}**\n${body.slice(0, 1500)}${link ? `\n${link}` : ""}` }),
            });
        } else {
            await fetch(url, {
                method: "POST",
                headers: { Title: title.replace(/[^\x20-\x7E]/g, ""), ...(link ? { Click: link } : {}) },
                body: body.slice(0, 3000),
            });
        }
    } catch (err) {
        log.warn("notify", `webhook failed: ${String(err)}`);
    }
}
