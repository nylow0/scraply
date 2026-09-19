export type ExportFile = { filename: string; content: string };

export function bundleBrowserIdeaExport(
  bundle: { filename: string; files: ExportFile[] },
  format: "markdown" | "json",
): ExportFile {
  const filename = bundle.filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (format === "json") {
    const entries = bundle.files.flatMap((file) => {
      const parsed: unknown = JSON.parse(file.content);
      return Array.isArray(parsed) ? parsed : [parsed];
    });
    return { filename, content: JSON.stringify(entries, null, 2) };
  }
  return {
    filename,
    content: `${bundle.files.map((file) => file.content.trimEnd()).join("\n\n---\n\n")}\n`,
  };
}
