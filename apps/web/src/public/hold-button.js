const instances = new WeakMap();
const DEFAULT_DURATION = 900;

function stopFrame(frameId) {
  if (frameId !== null) window.cancelAnimationFrame(frameId);
}

/**
 * Turn a button into an accessible hold-to-confirm action. A normal click is
 * never treated as confirmation, which protects destructive and privileged
 * actions from accidental activation.
 */
export function enhanceHoldButton(button, options = {}) {
  if (!(button instanceof HTMLButtonElement)) return null;
  const existing = instances.get(button);
  if (existing) return existing;

  const duration = Math.max(500, options.duration || DEFAULT_DURATION);
  const originalLabel = button.textContent?.trim() || "Confirm";
  const originalDisabled = button.disabled;
  const originalAriaLabel = button.getAttribute("aria-label");
  let frameId = null;
  let startedAt = 0;
  let holding = false;
  let busy = false;
  let suppressClick = false;

  const setProgress = (value) => {
    const progress = Math.max(0, Math.min(1, value));
    button.style.setProperty("--hold-progress", String(progress));
    if (progress >= 1) {
      button.setAttribute("aria-label", "Confirmed");
    } else {
      const accessibleLabel = originalAriaLabel || originalLabel;
      button.setAttribute("aria-label", `${accessibleLabel}. Hold to confirm, ${Math.round(progress * 100)} percent`);
    }
  };

  const reset = () => {
    stopFrame(frameId);
    frameId = null;
    holding = false;
    button.classList.remove("is-holding");
    if (originalAriaLabel === null) button.removeAttribute("aria-label");
    else button.setAttribute("aria-label", originalAriaLabel);
    button.style.setProperty("--hold-progress", "0");
  };

  const finish = async () => {
    if (!holding || busy) return;
    stopFrame(frameId);
    frameId = null;
    holding = false;
    busy = true;
    button.classList.remove("is-holding");
    button.classList.add("is-pending");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = options.pendingLabel || "Working…";
    setProgress(1);

    try {
      await options.onConfirm?.();
    } catch (error) {
      options.onError?.(error);
    } finally {
      busy = false;
      button.classList.remove("is-pending");
      button.disabled = originalDisabled;
      button.removeAttribute("aria-busy");
      button.textContent = originalLabel;
      if (originalAriaLabel === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", originalAriaLabel);
      reset();
    }
  };

  const tick = (timestamp) => {
    if (!holding) return;
    const progress = (timestamp - startedAt) / duration;
    setProgress(progress);
    if (progress >= 1) {
      void finish();
      return;
    }
    frameId = window.requestAnimationFrame(tick);
  };

  const start = (event) => {
    if (busy || button.disabled || holding) return;
    if (event?.type === "pointerdown" && event.button !== 0) return;
    holding = true;
    suppressClick = true;
    startedAt = performance.now();
    button.classList.add("is-holding");
    setProgress(0);
    if (event?.pointerId !== undefined) {
      try { button.setPointerCapture(event.pointerId); } catch { /* pointer capture is optional */ }
    }
    frameId = window.requestAnimationFrame(tick);
  };

  const cancel = (event) => {
    if (!holding) return;
    if (event?.pointerId !== undefined && button.hasPointerCapture?.(event.pointerId)) {
      try { button.releasePointerCapture(event.pointerId); } catch { /* pointer capture is optional */ }
    }
    reset();
    window.setTimeout(() => { suppressClick = false; }, 0);
  };

  const clickHandler = (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  };

  button.classList.add("aevo-hold-button");
  button.setAttribute("aria-description", "Press and hold to confirm this action.");
  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", cancel);
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("lostpointercapture", cancel);
  button.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      start(event);
    }
  });
  button.addEventListener("keyup", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      cancel(event);
    }
  });
  button.addEventListener("click", clickHandler, true);

  const instance = { cancel, finish };
  instances.set(button, instance);
  return instance;
}
