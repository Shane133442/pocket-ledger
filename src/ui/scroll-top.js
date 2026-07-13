export function initScrollTopButton({ onNavigate }) {
  const menu = document.getElementById("appMenu");
  const main = document.getElementById("appMenuMain");
  const backdrop = document.getElementById("appMenuBackdrop");
  const items = [...document.querySelectorAll(".app-menu-item")];

  let pressTimer = null;
  let isOpen = false;
  let longPressArmed = false;
  let openMode = "tap";
  let lastTapAt = 0;
  let target = null;

  const suppressNativeTouchUi = (event) => {
    event.preventDefault();
  };

  const showMenu = () => {
    menu.hidden = false;
    menu.classList.add("is-ready");
  };

  const highlight = (item) => {
    target = item;
    items.forEach((entry) => entry.classList.toggle("is-target", entry === item));
  };

  const close = () => {
    isOpen = false;
    longPressArmed = false;
    target = null;
    openMode = "tap";
    menu.classList.remove("is-open");
    backdrop.hidden = true;
    items.forEach((item) => item.classList.remove("is-target"));
  };

  const open = (mode = "tap") => {
    showMenu();
    isOpen = true;
    openMode = mode;
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

  const navigate = (page) => {
    close();
    onNavigate(page);
    showMenu();
  };

  const goCaptureTop = () => {
    navigate("capture");
  };

  main.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    showMenu();
    longPressArmed = true;
    target = null;
    main.setPointerCapture?.(event.pointerId);
    window.clearTimeout(pressTimer);
    pressTimer = window.setTimeout(() => {
      if (!longPressArmed) return;
      open("hold");
    }, 330);
  });

  main.addEventListener("pointermove", (event) => {
    event.preventDefault();
    if (!isOpen) return;
    highlight(itemAtPoint(event.clientX, event.clientY));
  });

  main.addEventListener("pointerup", (event) => {
    event.preventDefault();
    window.clearTimeout(pressTimer);
    longPressArmed = false;

    if (isOpen) {
      const selected = target || itemAtPoint(event.clientX, event.clientY);
      if (selected) navigate(selected.dataset.pageTab);
      else if (openMode === "hold") close();
      return;
    }

    const now = Date.now();
    if (now - lastTapAt <= 320) {
      lastTapAt = 0;
      open("tap");
      return;
    }
    lastTapAt = now;
    goCaptureTop();
  });

  main.addEventListener("pointercancel", () => {
    window.clearTimeout(pressTimer);
    longPressArmed = false;
    if (openMode === "hold") close();
  });

  items.forEach((item) => {
    item.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      highlight(item);
    });
    item.addEventListener("pointerup", (event) => {
      event.preventDefault();
      navigate(item.dataset.pageTab);
    });
    item.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(item.dataset.pageTab);
    });
    item.addEventListener("contextmenu", suppressNativeTouchUi);
    item.addEventListener("selectstart", suppressNativeTouchUi);
  });

  main.addEventListener("contextmenu", suppressNativeTouchUi);
  main.addEventListener("selectstart", suppressNativeTouchUi);
  menu.addEventListener("contextmenu", suppressNativeTouchUi);
  menu.addEventListener("selectstart", suppressNativeTouchUi);
  backdrop.addEventListener("click", close);

  showMenu();
}
