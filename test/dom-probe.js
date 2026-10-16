() => {
  const out = {};
  const btns = document.querySelectorAll('.dshcb-btn');
  out.dshcbCount = btns.length;
  out.dshcbInfo = Array.from(btns).map(function (b) {
    return {
      tag: b.tagName,
      cls: b.className,
      title: b.getAttribute('title') || b.getAttribute('aria-label') || null,
      html: b.outerHTML.slice(0, 200),
    };
  });
  out.styleTags = Array.from(document.querySelectorAll('style[data-plugin-css]')).map(function (s) {
    return s.getAttribute('data-plugin-css');
  });
  const ta = document.querySelector('textarea, [contenteditable=true]');
  out.composer = ta ? { tag: ta.tagName, cls: String(ta.className).slice(0, 120) } : null;
  return JSON.stringify(out, null, 1);
}
