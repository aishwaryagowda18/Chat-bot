// A small, dependency-free Markdown renderer for chat replies.
// All text is HTML-escaped before formatting is applied, so model output can
// never inject markup. Supports headings, paragraphs, bold/italic/strikethrough,
// inline code, fenced code blocks, lists (nested), blockquotes, tables, links
// and horizontal rules. It also tolerates incomplete Markdown while streaming.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>';

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableSeparator = (line) => line.includes("|") && TABLE_SEPARATOR.test(line);

function link(url, label) {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** Renders inline Markdown (code, links, emphasis) for a single line of text. */
function inline(raw) {
  const slots = [];
  const hold = (html) => `\u0001${slots.push(html) - 1}\u0001`;

  let text = raw
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
      hold(link(url, escapeHtml(label))),
    )
    .replace(/https?:\/\/[^\s<>()\u0001]+/g, (match) => {
      const trailing = match.match(/[.,;:!?'"]+$/)?.[0] ?? "";
      const url = trailing ? match.slice(0, -trailing.length) : match;
      return hold(link(url, escapeHtml(url))) + trailing;
    });

  text = escapeHtml(text)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");

  return text.replace(/\u0001(\d+)\u0001/g, (_, i) => slots[i]);
}

function codeBlock(code, lang) {
  return (
    `<div class="code"><div class="code-head"><span>${escapeHtml(lang || "code")}</span>` +
    `<button type="button" class="copy-code" aria-label="Copy code">${COPY_ICON}<span>Copy</span></button></div>` +
    `<pre><code>${escapeHtml(code)}</code></pre></div>`
  );
}

function splitRow(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

const indentOf = (line) => line.match(/^\s*/)[0].length;

function renderBlocks(lines) {
  const out = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (an unclosed fence runs to the end, which is what we want while streaming).
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w#+.-]*)/);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push(codeBlock(code.join("\n"), fence[2]));
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "",
      );
      const cell = (tag, text, col) =>
        `<${tag}${aligns[col] ? ` style="text-align:${aligns[col]}"` : ""}>${inline(text ?? "")}</${tag}>`;
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i++]));
      }
      out.push(
        `<div class="table-wrap"><table><thead><tr>${header.map((h, c) => cell("th", h, c)).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${header.map((_, c) => cell("td", r[c], c)).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      }
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    const first = line.match(LIST_ITEM);
    if (first) {
      flush();
      const ordered = /\d/.test(first[2]);
      const base = first[1].length;
      const items = [];
      let contentIndent = 0;

      while (i < lines.length) {
        const current = lines[i];
        const item = current.match(LIST_ITEM);
        if (item && item[1].length <= base + 1) {
          if (/\d/.test(item[2]) !== ordered) break; // a different kind of list starts
          items.push([item[3]]);
          contentIndent = item[1].length + item[2].length + 1;
          i++;
        } else if (!current.trim()) {
          // A blank line continues the list only if more list content follows.
          const next = lines[i + 1];
          const nextItem = next?.match(LIST_ITEM);
          const continues =
            next !== undefined &&
            ((nextItem && nextItem[1].length <= base + 1 && /\d/.test(nextItem[2]) === ordered) ||
              (next.trim() && indentOf(next) > base));
          if (!continues) break;
          items.at(-1).push("");
          i++;
        } else if (indentOf(current) > base) {
          items.at(-1).push(current.slice(Math.min(indentOf(current), contentIndent)));
          i++;
        } else {
          break;
        }
      }

      const start = ordered ? parseInt(first[2], 10) : 1;
      const tag = ordered ? "ol" : "ul";
      const body = items
        .map((itemLines) => {
          const html = renderBlocks(itemLines);
          // Keep simple one-paragraph items tight (no <p> wrapper).
          const tight = html.match(/^<p>([\s\S]*?)<\/p>(?![\s\S]*<p>)([\s\S]*)$/);
          return `<li>${tight ? tight[1] + tight[2] : html}</li>`;
        })
        .join("");
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${body}</${tag}>`);
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }

  flush();
  return out.join("");
}

/** Converts a Markdown string to safe HTML. */
export function renderMarkdown(source) {
  const text = String(source ?? "").replace(/\u0001/g, "").replace(/\r\n?/g, "\n");
  return renderBlocks(text.split("\n"));
}
