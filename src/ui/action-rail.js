export function initActionRail({ onEdit, onSave, onVoice }) {
  const rail = document.getElementById("actionRail"); const thumb = document.getElementById("actionThumb"); let startX = 0; let delta = 0;
  const reset = () => { rail.classList.remove("is-interacting"); thumb.style.transform = "translateX(0)"; };
  const finish = () => { if (delta < -52) onEdit(); else if (delta > 52) onVoice(); else onSave(); reset(); };
  thumb.addEventListener("pointerdown", (event) => { startX = event.clientX; delta = 0; rail.classList.add("is-interacting"); thumb.setPointerCapture(event.pointerId); });
  thumb.addEventListener("pointermove", (event) => { if (!thumb.hasPointerCapture(event.pointerId)) return; const max = Math.max(60, rail.clientWidth / 3); delta = Math.max(-max, Math.min(max, event.clientX - startX)); thumb.style.transform = `translateX(${delta}px)`; });
  thumb.addEventListener("pointerup", finish); thumb.addEventListener("pointercancel", reset);
  document.getElementById("railEditButton").addEventListener("click", onEdit); document.getElementById("railVoiceButton").addEventListener("click", onVoice);
}
