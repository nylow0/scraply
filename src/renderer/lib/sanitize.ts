import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "article", "section", "h1", "h2", "h3", "h4", "p", "ul", "ol", "li",
  "strong", "em", "a", "blockquote", "code", "pre", "table", "thead", "tbody", "tr", "th", "td",
  "hr", "br",
];

export function sanitizeReportHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "class"],
    ALLOW_DATA_ATTR: false,
  });
}
