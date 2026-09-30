// Applied before first paint (synchronous <script src> in index.html) to set
// the persisted theme on <html> and avoid a light/dark flash. Kept separate
// from the bundle so the CSP can use script-src 'self' with no hashes.
(function () {
  try {
    var t = localStorage.getItem("glyph.theme");
    if (t !== "light" && t !== "dark")
      t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
