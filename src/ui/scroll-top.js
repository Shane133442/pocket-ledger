export function initScrollTopButton() {
  const button = document.getElementById("scrollTopButton"); const capture = document.getElementById("captureStart");
  const observer = new IntersectionObserver(([entry]) => { button.hidden = entry.isIntersecting; }, { threshold: 0.08 });
  observer.observe(capture);
  button.addEventListener("click", () => { capture.scrollIntoView({ behavior: "smooth", block: "start" }); window.setTimeout(() => document.getElementById("actionThumb")?.focus({ preventScroll: true }), 450); });
}
