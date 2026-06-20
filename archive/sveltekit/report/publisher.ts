import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PublishedReport {
  localPath: string;
  url?: string;
}

export interface Publisher {
  publish(report: { slug: string; markdown: string }): Promise<PublishedReport>;
}

export class LocalMarkdownPublisher implements Publisher {
  constructor(private readonly outputDirectory: string) {}

  async publish(report: { slug: string; markdown: string }): Promise<PublishedReport> {
    await mkdir(this.outputDirectory, { recursive: true });
    const localPath = resolve(join(this.outputDirectory, `${report.slug}.md`));
    await writeFile(localPath, report.markdown.endsWith("\n") ? report.markdown : `${report.markdown}\n`, "utf8");
    return { localPath };
  }
}

export class ShareCommandPublisher implements Publisher {
  constructor(
    private readonly local: LocalMarkdownPublisher,
    private readonly command = "C:\\Business\\planning\\publish-plan.cmd",
  ) {}

  async publish(report: { slug: string; markdown: string }): Promise<PublishedReport> {
    const localResult = await this.local.publish(report);
    const command = this.command.toLocaleLowerCase().endsWith(".cmd")
      ? ["cmd.exe", "/d", "/s", "/c", `"${this.command}" "${localResult.localPath}"`]
      : [this.command, localResult.localPath];
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Share publisher failed (${exitCode}): ${stderr.trim()}`);
    const url = stdout.trim().split(/\s+/).find((value) => /^https:\/\/[^\s]+\.llm-plans\.com\/?$/.test(value));
    if (!url) throw new Error("Share publisher completed without an llm-plans.com URL");
    return { ...localResult, url };
  }
}
