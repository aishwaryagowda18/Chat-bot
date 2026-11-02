import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "../public/markdown.js";

test("escapes HTML so replies can't inject markup", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> **bold**');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("renders inline formatting and safe links", () => {
  const html = renderMarkdown("Use `npm start`, see [docs](https://example.com/a_b_c) or *this*.");
  assert.match(html, /<code>npm start<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/a_b_c" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<em>this<\/em>/);
  assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /href="javascript/);
});

test("renders fenced code, including an unclosed fence while streaming", () => {
  const closed = renderMarkdown("```js\nconst a = 1 < 2;\n```");
  assert.match(closed, /<span>js<\/span>/);
  assert.match(closed, /const a = 1 &lt; 2;/);
  const open = renderMarkdown("Here:\n```python\nprint('hi')");
  assert.match(open, /print\(&#39;hi&#39;\)/);
});

test("renders lists, nested lists, headings and tables", () => {
  const html = renderMarkdown("## Title\n\n1. One\n2. Two\n   - nested\n\n| A | B |\n|---|:-:|\n| 1 | 2 |");
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<ol><li>One<\/li><li>Two<ul><li>nested<\/li><\/ul><\/li><\/ol>/);
  assert.match(html, /<th>A<\/th><th style="text-align:center">B<\/th>/);
  assert.match(html, /<td>1<\/td><td style="text-align:center">2<\/td>/);
});
