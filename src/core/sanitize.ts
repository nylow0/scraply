import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const dom = new JSDOM("");
const purify = DOMPurify(dom.window as unknown as Parameters<typeof DOMPurify>[0]);

const ALLOWED_TAGS = [
  "article", "section", "h1", "h2", "h3", "h4", "p", "ul", "ol", "li",
  "strong", "em", "a", "blockquote", "code", "pre", "table", "thead", "tbody", "tr", "th", "td",
];

export function sanitizeReportHtml(html: string): string {
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "class"],
    ALLOW_DATA_ATTR: false,
  });
}

export function wrapReportHtml(title: string, body: string): string {
  return sanitizeReportHtml(`<article><header><h1>${escapeHtml(title)}</h1></header><section>${body}</section></article>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
