// mdBook leaves ```mermaid blocks as code; render them as diagrams. Mermaid
// is only fetched on pages that have one.
(async () => {
  const blocks = document.querySelectorAll("code.language-mermaid");
  if (blocks.length === 0) return;
  const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs");
  const html = document.documentElement.classList;
  const dark = ["coal", "navy", "ayu"].some((theme) => html.contains(theme));
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral" });
  for (const code of blocks) {
    const diagram = document.createElement("pre");
    diagram.className = "mermaid";
    diagram.textContent = code.textContent;
    code.parentElement.replaceWith(diagram);
  }
  await mermaid.run();
})();
