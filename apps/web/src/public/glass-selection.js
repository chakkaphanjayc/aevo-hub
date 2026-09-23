const instances = new WeakMap();

function getActiveItem(container, selector) {
  return Array.from(container.querySelectorAll(selector)).find((item) => (
    item.classList.contains("active")
    || item.getAttribute("aria-current") === "page"
    || item.getAttribute("aria-selected") === "true"
  )) || null;
}

function setSelectionPosition(container, indicator, selector) {
  const activeItem = getActiveItem(container, selector);
  if (!activeItem || !activeItem.isConnected) {
    indicator.hidden = true;
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const itemRect = activeItem.getBoundingClientRect();
  indicator.style.setProperty("--glass-selection-x", `${itemRect.left - containerRect.left}px`);
  indicator.style.setProperty("--glass-selection-y", `${itemRect.top - containerRect.top}px`);
  indicator.style.setProperty("--glass-selection-width", `${itemRect.width}px`);
  indicator.style.setProperty("--glass-selection-height", `${itemRect.height}px`);
  indicator.hidden = false;
}

/**
 * Attach one shared glass indicator to a tab, stepper, or navigation surface.
 * The active item remains semantic; the indicator supplies the visual motion.
 */
export function attachGlassSelection(container, { itemSelector }) {
  if (!(container instanceof HTMLElement) || !itemSelector) return null;

  let instance = instances.get(container);
  if (!instance) {
    const indicator = document.createElement("span");
    indicator.className = "aevo-glass-selection-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.hidden = true;

    const ensureIndicator = () => {
      if (!indicator.isConnected || indicator.parentElement !== container) container.appendChild(indicator);
      container.classList.add("aevo-glass-selection");
    };

    instance = {
      selector: itemSelector,
      sync() {
        ensureIndicator();
        setSelectionPosition(container, indicator, instance.selector);
      },
      observer: null,
      resizeHandler: null,
      clickHandler: null,
      queuedFrame: null
    };

    const queueSync = () => {
      if (instance.queuedFrame !== null) return;
      instance.queuedFrame = window.requestAnimationFrame(() => {
        instance.queuedFrame = null;
        instance?.sync();
      });
    };

    instance.clickHandler = (event) => {
      if (event.target instanceof Element && event.target.closest(instance.selector)) {
        queueSync();
      }
    };
    instance.resizeHandler = queueSync;
    instance.observer = new MutationObserver(queueSync);

    container.addEventListener("click", instance.clickHandler);
    window.addEventListener("resize", instance.resizeHandler, { passive: true });
    instance.observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      // Do not observe the indicator's own hidden state. sync() updates it,
      // so observing it would schedule another sync for every paint.
      attributeFilter: ["class", "aria-current", "aria-selected"]
    });
    instances.set(container, instance);
  } else {
    instance.selector = itemSelector;
  }

  instance.sync();
  return instance;
}
