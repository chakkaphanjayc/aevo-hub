export const designSystemVersion = "0.1.0" as const;

export const designTokens = {
  color: {
    canvas: "#f6f8f5",
    surface: "rgba(255, 255, 255, 0.78)",
    ink: "#192019",
    muted: "#63705f",
    brand: "#5b7b58",
    brandDark: "#2d4a30",
    success: "#35633a",
    warning: "#8b682b",
    danger: "#9e362d"
  },
  radius: {
    small: "8px",
    medium: "12px",
    large: "18px",
    pill: "999px"
  },
  motion: {
    fast: "140ms",
    normal: "220ms"
  }
} as const;

export type DesignTokens = typeof designTokens;

export {
  Button,
  Breadcrumbs,
  Card,
  Combobox,
  CommandMenu,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  FilterChip,
  FormField,
  GroupSelect,
  Input,
  LoadingState,
  OfflineState,
  Pagination,
  PermissionDeniedState,
  SearchBar,
  Select,
  SortSelect,
  StatusBadge,
  Toast,
  ToastRegion
} from "./components";

export type {
  ButtonProps,
  BreadcrumbItem,
  ComboboxProps,
  CommandItem,
  DataTableProps,
  DialogProps,
  DrawerProps,
  FilterChipProps,
  FormFieldProps,
  InputProps,
  PaginationProps,
  SearchBarProps,
  OptionItem,
  SelectProps,
  StatePanelProps,
  StatusBadgeProps,
  ToastProps,
  ToastRegionProps
} from "./components";
