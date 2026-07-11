export function initScrollTopButton({ getCurrentPage, onNavigate }) {
  const menu = document.getElementById("appMenu");
  const main = document.getElementById("appMenuMain");
  const backdrop = document.getElementById("appMenuBackdrop");
  const capture = document.getElementById("captureStart");
  const items = [...document.querySelectorAll(".app-menu-item")];
  let captureVisible = true;
  let pressTimer = null;
  let isOpen = false;
  let didLongPress = false;
  let target = null;

  const setMenuVisibility = () => {
    menu.hidden = getCurrentPage() === "capture" && captureVisible;
  };
  const close = () => {
    isOpen = false;
    target = null;
    menu.classList.remove("is-open");
    backdrop.hidden = true;
    items.forEach((item) => item.classList.remove("is-target"));
  };
  const open = () => {
    didLongPress = true;
    isOpen = true;
    menu.hidden = false;
    menu.classList.add("is-open");
    backdrop.hidden = false;
  };
  const itemAtPoint = (x, y) => {
    if (!isOpen) return null;
    return items.find((item) => {
      const rect = item.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
  };
  const highlight = (item) => {
    target = item;
    items.forEach((entry) => entry.classList.toggle("is-target", entry === item));
  };
  const navigate = (page) => {
    close();
    onNavigate(page);
    setMenuVisibility();
  };
  const suppressNativeTouchUi = (event) => {
    event.preventDefault();
  };

  const observer = new IntersectionObserver(([entry]) => {
    captureVisible = entry.isIntersecting;
    setMenuVisibility();
  }, { threshold: 0.08 });
  observer.observe(capture);

  main.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    didLongPress = false;
    main.setPointerCapture(event.pointerId);
    pressTimer = window.setTimeout(open, 330);
  });
  main.addEventListener("pointermove", (event) => {
    event.preventDefault();
    if (!isOpen) return;
    highlight(itemAtPoint(event.clientX, event.clientY));
  });
  main.addEventListener("pointerup", (event) => {
    event.preventDefault();
    window.clearTimeout(pressTimer);
    if (isOpen) {
      const selected = target || itemAtPoint(event.clientX, event.clientY);
      if (selected) navigate(selected.dataset.pageTab);
      else close();
      return;
    }
    if (!didLongPress) navigate("capture");
  });
  main.addEventListener("pointercancel", () => {
    window.clearTimeout(pressTimer);
    close();
  });
  main.addEventListener("contextmenu", suppressNativeTouchUi);
  menu.addEventListener("contextmenu", suppressNativeTouchUi);
  menu.addEventListener("selectstart", suppressNativeTouchUi);
  menu.addEventListener("touchstart", suppressNativeTouchUi, { passive: false });
  items.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(item.dataset.pageTab);
    });
    item.addEventListener("contextmenu", suppressNativeTouchUi);
  });
  backdrop.addEventListener("click", close);
  setMenuVisibility();
}
