import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type DialogHTMLAttributes, type FormHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";
type StateTone = "loading" | "empty" | "error" | "denied" | "offline";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
  busyLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", busy = false, busyLabel = "Working…", children, disabled, className = "", ...props },
  ref
) {
  return (
    <button
      {...props}
      ref={ref}
      className={`aevo-button aevo-button--${variant} ${className}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="aevo-button__busy" aria-hidden="true" /> : null}
      <span>{busy ? busyLabel : children}</span>
    </button>
  );
});

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "article" | "section" | "div";
}

export function Card({ as = "article", className = "", children, ...props }: CardProps) {
  const Component = as;
  return <Component {...props} className={`aevo-card ${className}`.trim()}>{children}</Component>;
}

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  dot?: boolean;
}

export function StatusBadge({ tone = "neutral", dot = true, className = "", children, ...props }: StatusBadgeProps) {
  return <span {...props} className={`aevo-status aevo-status--${tone} ${dot ? "" : "aevo-status--no-dot"} ${className}`.trim()}>{children}</span>;
}

export interface FormFieldProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
}

export function FormField({ label, htmlFor, hint, error, required, children, className = "", ...props }: FormFieldProps) {
  return (
    <div {...props} className={`aevo-field ${className}`.trim()}>
      <label className="aevo-field__label" htmlFor={htmlFor}>
        <span>{label}{required ? <span className="aevo-field__required" aria-hidden="true"> *</span> : null}</span>
        {children}
      </label>
      {error ? <p className="aevo-field__error" role="alert">{error}</p> : hint ? <p className="aevo-field__hint">{hint}</p> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ error = false, className = "", ...props }, ref) {
  return <input {...props} ref={ref} className={`aevo-control ${error ? "aevo-control--error" : ""} ${className}`.trim()} aria-invalid={error || undefined} />;
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ error = false, className = "", ...props }, ref) {
  return <select {...props} ref={ref} className={`aevo-control ${error ? "aevo-control--error" : ""} ${className}`.trim()} aria-invalid={error || undefined} />;
});

export interface StatePanelProps extends HTMLAttributes<HTMLElement> {
  tone: StateTone;
  title: string;
  description?: string;
  action?: ReactNode;
}

function stateRole(tone: StateTone): "status" | "alert" {
  return tone === "error" || tone === "denied" ? "alert" : "status";
}

export function StatePanel({ tone, title, description, action, className = "", children, ...props }: StatePanelProps) {
  return (
    <section {...props} className={`aevo-state aevo-state--${tone} ${className}`.trim()} role={stateRole(tone)} aria-live={tone === "loading" ? "polite" : undefined}>
      <span className="aevo-state__tone">{tone === "loading" ? "Loading" : tone === "offline" ? "Offline" : tone === "denied" ? "Permission required" : tone === "error" ? "Could not load" : "Nothing here yet"}</span>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {children}
      {action ? <div className="aevo-state__action">{action}</div> : null}
    </section>
  );
}

export function LoadingState(props: Omit<StatePanelProps, "tone">) {
  return <StatePanel {...props} tone="loading" />;
}

export function EmptyState(props: Omit<StatePanelProps, "tone">) {
  return <StatePanel {...props} tone="empty" />;
}

export function ErrorState(props: Omit<StatePanelProps, "tone">) {
  return <StatePanel {...props} tone="error" />;
}

export function PermissionDeniedState(props: Omit<StatePanelProps, "tone">) {
  return <StatePanel {...props} tone="denied" />;
}

export function OfflineState(props: Omit<StatePanelProps, "tone">) {
  return <StatePanel {...props} tone="offline" />;
}

export interface DataTableProps extends HTMLAttributes<HTMLDivElement> {
  caption?: string;
}

export function DataTable({ caption, className = "", children, ...props }: DataTableProps) {
  return <div {...props} className={`aevo-data-table-shell ${className}`.trim()}>{caption ? <div className="aevo-data-table__caption">{caption}</div> : null}{children}</div>;
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items, className = "", ...props }: { items: BreadcrumbItem[] } & HTMLAttributes<HTMLElement>) {
  return <nav {...props} className={`aevo-breadcrumbs ${className}`.trim()} aria-label="Breadcrumb"><ol>{items.map((item, index) => <li key={`${item.label}-${index}`}>{item.href ? <a href={item.href}>{item.label}</a> : <span aria-current="page">{item.label}</span>}</li>)}</ol></nav>;
}

export interface SearchBarProps extends FormHTMLAttributes<HTMLFormElement> {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
}

export function SearchBar({ label = "Search", placeholder = "Search", defaultValue, className = "", ...props }: SearchBarProps) {
  return <form {...props} className={`aevo-search-bar ${className}`.trim()} role="search"><label><span className="aevo-sr-only">{label}</span><Input type="search" name="q" defaultValue={defaultValue} placeholder={placeholder} aria-label={label} /><Button type="submit" variant="secondary">Search</Button></label></form>;
}

export interface FilterChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function FilterChip({ active = false, className = "", children, ...props }: FilterChipProps) {
  return <button {...props} type={props.type ?? "button"} className={`aevo-filter-chip ${active ? "is-active" : ""} ${className}`.trim()} aria-pressed={active}>{children}</button>;
}

export interface PaginationProps extends HTMLAttributes<HTMLElement> {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageCount, onPageChange, className = "", ...props }: PaginationProps) {
  const safePage = Math.min(Math.max(page, 1), Math.max(pageCount, 1));
  return <nav {...props} className={`aevo-pagination ${className}`.trim()} aria-label="Pagination"><Button type="button" variant="ghost" disabled={safePage <= 1} onClick={() => onPageChange(safePage - 1)}>Previous</Button><span aria-live="polite">Page {safePage} of {Math.max(pageCount, 1)}</span><Button type="button" variant="ghost" disabled={safePage >= pageCount} onClick={() => onPageChange(safePage + 1)}>Next</Button></nav>;
}

export interface OptionItem {
  value: string;
  label: string;
}

export interface ComboboxProps extends Omit<InputProps, "defaultValue" | "onChange" | "value"> {
  options: OptionItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  emptyMessage?: string;
}

export function Combobox({
  options,
  value,
  defaultValue = "",
  onValueChange,
  emptyMessage = "No matching options",
  id,
  className = "",
  onBlur,
  onFocus,
  onKeyDown,
  placeholder = "Choose an option",
  ...props
}: ComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? `aevo-combobox-${generatedId}`;
  const listboxId = `${inputId}-listbox`;
  const initialOption = options.find((option) => option.value === defaultValue);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const [inputValue, setInputValue] = useState(initialOption?.label ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedValue = value ?? uncontrolledValue;
  const selectedOption = options.find((option) => option.value === selectedValue);
  const normalizedQuery = inputValue.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
    : options;

  useEffect(() => {
    if (value === undefined) return;
    setInputValue(selectedOption?.label ?? "");
  }, [selectedOption?.label, value]);

  function selectOption(option: OptionItem) {
    setUncontrolledValue(option.value);
    setInputValue(option.label);
    setOpen(false);
    setActiveIndex(0);
    onValueChange?.(option.value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(filteredOptions.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && open && filteredOptions[activeIndex]) {
      event.preventDefault();
      selectOption(filteredOptions[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="aevo-combobox">
      <Input
        {...props}
        id={inputId}
        className={className}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={open && filteredOptions[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
        value={inputValue}
        onChange={(event) => {
          setInputValue(event.currentTarget.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={(event) => {
          setOpen(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          window.setTimeout(() => setOpen(false), 0);
          onBlur?.(event);
        }}
        onKeyDown={handleKeyDown}
      />
      {open ? (
        <ul id={listboxId} className="aevo-combobox__listbox" role="listbox" aria-label={`${props["aria-label"] ?? "Options"}`}>
          {filteredOptions.length > 0 ? filteredOptions.map((option, index) => (
            <li
              id={`${listboxId}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === selectedValue}
              className={index === activeIndex ? "is-active" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectOption(option)}
            >
              {option.label}
            </li>
          )) : <li className="aevo-combobox__empty" role="status">{emptyMessage}</li>}
        </ul>
      ) : null}
    </div>
  );
}

export function SortSelect({ options, ...props }: { options: OptionItem[] } & SelectHTMLAttributes<HTMLSelectElement>) {
  return <label className="aevo-inline-select"><span>Sort</span><Select {...props}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>;
}

export function GroupSelect({ options, ...props }: { options: OptionItem[] } & SelectHTMLAttributes<HTMLSelectElement>) {
  return <label className="aevo-inline-select"><span>Group</span><Select {...props}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>;
}

export interface DrawerProps extends HTMLAttributes<HTMLElement> {
  open: boolean;
  title: string;
  onClose: () => void;
}

export function Drawer({ open, title, onClose, children, className = "", ...props }: DrawerProps) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);
  return <aside {...props} className={`aevo-drawer ${open ? "is-open" : ""} ${className}`.trim()} role="dialog" aria-modal="true" aria-hidden={!open} hidden={!open}><header><h2>{title}</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></header><div className="aevo-drawer__body">{children}</div></aside>;
}

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  onSelect: () => void;
}

export function CommandMenu({ open, items, onClose }: { open: boolean; items: CommandItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = normalizedQuery
    ? items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(normalizedQuery))
    : items;
  return <Dialog open={open} title="Command menu" description="Find a Hub action" onClose={onClose}><div className="aevo-command-menu"><Input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search actions" aria-label="Search actions" autoFocus />{filteredItems.length > 0 ? <ul>{filteredItems.map((item) => <li key={item.id}><button type="button" onClick={item.onSelect}><strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</button></li>)}</ul> : <EmptyState title="No matching actions" description="Try another search term." />}</div></Dialog>;
}

export interface DialogProps extends DialogHTMLAttributes<HTMLDialogElement> {
  open: boolean;
  title: string;
  description?: string;
  footer?: ReactNode;
}

export function Dialog({ open, title, description, footer, children, onClose, ...props }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog {...props} ref={dialogRef} aria-labelledby={titleId} onClose={onClose}>
      <header className="aevo-dialog__header">
        <div><h2 id={titleId}>{title}</h2>{description ? <p>{description}</p> : null}</div>
        <button className="aevo-dialog__close" type="button" aria-label="Close" onClick={() => dialogRef.current?.close()}>×</button>
      </header>
      <div className="aevo-dialog__body">{children}</div>
      {footer ? <footer className="aevo-dialog__footer">{footer}</footer> : null}
    </dialog>
  );
}

export interface ToastProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Exclude<StatusTone, "neutral">;
  title?: string;
  onDismiss?: () => void;
}

export function Toast({ tone = "info", title, onDismiss, children, className = "", ...props }: ToastProps) {
  return <div {...props} className={`aevo-toast aevo-toast--${tone} ${className}`.trim()} role="status"><div>{title ? <strong>{title}</strong> : null}<span>{children}</span></div>{onDismiss ? <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>×</button> : null}</div>;
}

export interface ToastRegionProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
}

export function ToastRegion({ children, className = "", ...props }: ToastRegionProps) {
  return <aside {...props} className={`aevo-toast-region ${className}`.trim()} aria-label="Notifications" aria-live="polite">{children}</aside>;
}
