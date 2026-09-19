let menuSequence = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

const commandIcons = {
  help: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"></circle><path d="M9.8 9.2a2.4 2.4 0 1 1 3.8 1.9c-1 .7-1.6 1.2-1.6 2.4"></path><path d="M12 16.8h.01"></path></svg>',
  search: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4 4"></path></svg>',
  logic: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 5h5v5H6zM13 14h5v5h-5z"></path><path d="M11 7.5h2a2 2 0 0 1 2 2V14"></path><path d="M13 16.5h-2a2 2 0 0 1-2-2V10"></path></svg>',
  filter: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"></path></svg>',
  plus: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>',
  sort: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5v14M5 8l3-3 3 3M16 19V5M13 16l3 3 3-3"></path></svg>',
  group: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="5" width="6" height="6" rx="1"></rect><rect x="14" y="5" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="5" rx="1"></rect><rect x="14" y="14" width="6" height="5" rx="1"></rect></svg>',
  saved: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 4.5h12v15l-6-3.4-6 3.4z"></path></svg>',
  save: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"></path><path d="M8 4v6h8V4M8 20v-6h8v6"></path></svg>',
  refresh: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19 8a7 7 0 0 0-12.5-1.8L5 8"></path><path d="M5 4v4h4M5 16a7 7 0 0 0 12.5 1.8L19 16"></path><path d="M19 20v-4h-4"></path></svg>',
  clear: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"></path></svg>'
};

function quoteStateBefore(value, end) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < end; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") quote = character;
  }
  return quote;
}

export function parseSlashToken(value) {
  const raw = String(value || "");
  const match = raw.match(/\/([^\s()"']*)(["'])?$/u);
  if (!match || typeof match.index !== "number") return null;
  const tokenStart = match.index;
  const previous = raw[tokenStart - 1] || "";
  const quote = quoteStateBefore(raw, tokenStart);
  const closingQuote = match[2] || "";
  const isBoundary = tokenStart === 0 || /\s/u.test(previous) || /["')]/u.test(previous);
  if (!isBoundary) return null;
  if (quote && !/\s/u.test(previous)) return null;
  if (closingQuote !== quote) return null;
  return {
    query: match[1].toLowerCase(),
    start: tokenStart,
    end: raw.length - closingQuote.length,
    kind: "command",
    closingQuote
  };
}

function normalizedCommands(commands) {
  return (Array.isArray(commands) ? commands : [])
    .filter((command) => command && typeof command.key === "string" && typeof command.label === "string")
    .map((command) => ({
      ...command,
      key: command.key.replace(/^\//u, "").toLowerCase(),
      description: command.description || "",
      keywords: Array.isArray(command.keywords) ? command.keywords : [],
      icon: command.icon || "help",
      insert: typeof command.insert === "string" ? command.insert : "",
      disabled: command.disabled === true
    }));
}

/**
 * Add an Odoo-style suggestion palette to a text input.
 *
 * Items are intentionally supplied by the owning feature. The palette owns
 * only keyboard behaviour, filtering, ARIA state, and input replacement; it
 * never decides what a command or search field is allowed to do.
 */
export function createSlashCommandMenu({
  input,
  anchor,
  getCommands,
  onSelect,
  getTrigger = parseSlashToken,
  replaceValue,
  menuTitle = "Commands",
  menuHint = "Tab to use · Enter to run · Esc to close",
  menuClassName = "aevo-slash-menu",
  renderTail,
  getFilter = (trigger) => trigger?.query || "",
  getCaret
}) {
  if (!(input instanceof HTMLInputElement) || !(anchor instanceof HTMLElement)) {
    throw new Error("Slash command menu requires an input and anchor element");
  }

  const menu = document.createElement("div");
  const menuId = `aevo-slash-menu-${++menuSequence}`;
  menu.id = menuId;
  menu.className = menuClassName;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", typeof menuTitle === "function" ? "Available suggestions" : menuTitle);
  menu.hidden = true;
  document.body.append(menu);

  let visibleCommands = [];
  let activeIndex = 0;
  let isManuallyOpened = false;
  let suppressNextInput = false;

  input.setAttribute("aria-controls", menuId);
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-haspopup", "listbox");

  function positionMenu() {
    if (menu.hidden) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const menuHeight = menuRect.height;
    const menuWidth = menuRect.width;
    const edgeGap = 12;
    const menuGap = 8;
    const roomBelow = window.innerHeight - anchorRect.bottom;
    const roomAbove = anchorRect.top;
    const shouldFlip = roomBelow < menuHeight + edgeGap && roomAbove > roomBelow;
    const preferredTop = shouldFlip
      ? anchorRect.top - menuHeight - menuGap
      : anchorRect.bottom + menuGap;
    const maxTop = Math.max(edgeGap, window.innerHeight - menuHeight - edgeGap);
    const left = Math.min(
      Math.max(edgeGap, anchorRect.left),
      Math.max(edgeGap, window.innerWidth - menuWidth - edgeGap)
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.min(Math.max(edgeGap, preferredTop), maxTop)}px`;
    menu.classList.toggle("is-flipped", shouldFlip);
  }

  function currentCommands(trigger) {
    return normalizedCommands(typeof getCommands === "function" ? getCommands(trigger) : []);
  }

  function setExpanded(expanded) {
    menu.hidden = !expanded;
    input.setAttribute("aria-expanded", String(expanded));
    if (!expanded) input.removeAttribute("aria-activedescendant");
    else positionMenu();
  }

  function updateActiveDescendant() {
    const active = menu.querySelector(`[data-command-index="${activeIndex}"]`);
    menu.querySelectorAll("[data-command-index]").forEach((node, index) => {
      const selected = index === activeIndex;
      node.setAttribute("aria-selected", String(selected));
      node.classList.toggle("is-active", selected);
    });
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    }
  }

  function render(filter = "", trigger = getTrigger(input.value)) {
    const query = String(filter || "").toLowerCase();
    const resolvedTitle = typeof menuTitle === "function" ? menuTitle(trigger) : menuTitle;
    const resolvedHint = typeof menuHint === "function" ? menuHint(trigger) : menuHint;
    menu.setAttribute("aria-label", resolvedTitle);
    const rankedCommands = currentCommands(trigger).map((command, index) => {
      if (!query) return { command, index, rank: 0 };
      const key = command.key.toLowerCase();
      const label = command.label.toLowerCase();
      const haystack = [key, label, command.description, ...command.keywords].join(" ").toLowerCase();
      if (!haystack.includes(query)) return null;
      const rank = key === query
        ? 0
        : key.startsWith(query)
          ? 1
          : label === query
            ? 2
            : label.startsWith(query)
              ? 3
              : 4;
      return { command, index, rank };
    }).filter(Boolean).sort((left, right) => left.rank - right.rank || left.index - right.index);
    visibleCommands = rankedCommands.map(({ command }) => command);
    activeIndex = Math.min(activeIndex, Math.max(visibleCommands.length - 1, 0));
    if (visibleCommands[activeIndex]?.disabled) {
      activeIndex = visibleCommands.findIndex((command) => !command.disabled);
      if (activeIndex < 0) activeIndex = 0;
    }

    const rows = visibleCommands.map((command, index) => `<button type="button" class="aevo-slash-command${command.disabled ? " is-disabled" : ""}" id="${menuId}-option-${index}" data-command-index="${index}" role="option" aria-selected="${index === activeIndex}"${command.disabled ? " disabled aria-disabled=\"true\"" : ""}>
      <span class="aevo-slash-command-icon">${commandIcons[command.icon] || commandIcons.help}</span>
      <span class="aevo-slash-command-copy"><strong>${escapeHtml(command.label)}</strong><span>${escapeHtml(command.description)}</span></span>
      <code>${escapeHtml(typeof renderTail === "function" ? renderTail(command) : `/${command.key}`)}</code>
    </button>`).join("");

    menu.innerHTML = `<div class="aevo-slash-menu-head"><strong>${escapeHtml(resolvedTitle)}</strong><span>${escapeHtml(resolvedHint)}</span></div>${rows || '<div class="aevo-slash-empty">No matching items</div>'}`;
    menu.querySelectorAll("[data-command-index]").forEach((node) => {
      node.addEventListener("mouseenter", () => {
        if (visibleCommands[Number(node.dataset.commandIndex || 0)]?.disabled) return;
        activeIndex = Number(node.dataset.commandIndex || 0);
        updateActiveDescendant();
      });
      node.addEventListener("click", () => {
        const command = visibleCommands[Number(node.dataset.commandIndex || 0)];
        if (!command?.disabled) applyCommand(command);
      });
    });
    updateActiveDescendant();
  }

  function open(filter = "", { manual = false, trigger = getTrigger(input.value) } = {}) {
    isManuallyOpened = manual;
    activeIndex = 0;
    render(filter, trigger);
    setExpanded(true);
  }

  function close() {
    isManuallyOpened = false;
    setExpanded(false);
  }

  function applyCommand(command) {
    if (!command) return;
    const parsed = getTrigger(input.value);
    if (parsed) {
      const before = input.value.slice(0, parsed.start);
      const after = input.value.slice(parsed.end);
      const replacement = typeof replaceValue === "function"
        ? replaceValue(input.value, parsed, command)
        : `${before}${command.insert}${after}`;
      input.value = replacement;
      const defaultCaret = typeof replaceValue === "function" ? replacement.length : before.length + command.insert.length;
      const preferredCaret = typeof getCaret === "function" ? getCaret(replacement, parsed, command) : defaultCaret;
      const caret = Number.isFinite(preferredCaret) ? preferredCaret : defaultCaret;
      input.setSelectionRange?.(caret, caret);
    }
    close();
    suppressNextInput = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    void onSelect?.(command, {
      input,
      parsed,
      close,
      insert: (value) => {
        const current = getTrigger(input.value);
        if (!current) return;
        const before = input.value.slice(0, current.start);
        const after = input.value.slice(current.end);
        const replacement = typeof replaceValue === "function"
          ? replaceValue(input.value, current, { ...command, insert: value })
          : `${before}${value}${after}`;
        input.value = replacement;
        const defaultCaret = typeof replaceValue === "function" ? replacement.length : before.length + value.length;
        const preferredCaret = typeof getCaret === "function" ? getCaret(replacement, current, { ...command, insert: value }) : defaultCaret;
        const caret = Number.isFinite(preferredCaret) ? preferredCaret : defaultCaret;
        input.setSelectionRange?.(caret, caret);
        suppressNextInput = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      reopen: () => {
        input.value = `${input.value.replace(/\s+$/u, "")} /`.trimStart();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        open("", { manual: true, trigger: getTrigger(input.value) });
        input.focus();
      }
    });
  }

  function handleInput() {
    const parsed = getTrigger(input.value);
    if (suppressNextInput) {
      suppressNextInput = false;
      if (!parsed) close();
      return;
    }
    if (!parsed) {
      if (!isManuallyOpened) close();
      return;
    }
    open(getFilter(parsed), { trigger: parsed });
  }

  function handleKeyDown(event) {
    if (menu.hidden) return;
    if (event.key === "ArrowDown") {
      if (visibleCommands.length === 0) return;
      event.preventDefault();
      let next = activeIndex;
      do {
        next = (next + 1) % visibleCommands.length;
      } while (visibleCommands[next]?.disabled && next !== activeIndex);
      if (visibleCommands[next]?.disabled) return;
      activeIndex = next;
      updateActiveDescendant();
      return;
    }
    if (event.key === "ArrowUp") {
      if (visibleCommands.length === 0) return;
      event.preventDefault();
      let next = activeIndex;
      do {
        next = (next - 1 + visibleCommands.length) % visibleCommands.length;
      } while (visibleCommands[next]?.disabled && next !== activeIndex);
      if (visibleCommands[next]?.disabled) return;
      activeIndex = next;
      updateActiveDescendant();
      return;
    }
    if ((event.key === "Tab" || event.key === "Enter") && visibleCommands[activeIndex] && !visibleCommands[activeIndex].disabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      applyCommand(visibleCommands[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }

  function handleOutsidePointer(event) {
    if (!anchor.contains(event.target) && !menu.contains(event.target)) close();
  }

  input.addEventListener("input", handleInput);
  input.addEventListener("keydown", handleKeyDown);
  document.addEventListener("pointerdown", handleOutsidePointer, true);
  window.addEventListener("resize", positionMenu);
  window.addEventListener("scroll", positionMenu, true);

  return {
    open: () => open("", { manual: true }),
    close,
    isOpen: () => !menu.hidden,
    destroy: () => {
      input.removeEventListener("input", handleInput);
      input.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      menu.remove();
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-expanded");
      input.removeAttribute("aria-haspopup");
      input.removeAttribute("aria-activedescendant");
    }
  };
}
