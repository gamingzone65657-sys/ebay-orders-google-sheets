import {
  ArrowLeftRight,
  Clock,
  Filter,
  LayoutDashboard,
  Package,
  Repeat,
  Settings,
  Sheet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    description: "Connection status and sync activity at a glance.",
  },
  {
    href: "/orders",
    label: "Orders",
    icon: Package,
    description: "Every eBay order imported into this workspace.",
  },
  {
    href: "/field-mapping",
    label: "Field Mapping",
    icon: ArrowLeftRight,
    description: "Decide which eBay field fills each spreadsheet column.",
  },
  {
    href: "/google-sheet",
    label: "Google Sheet",
    icon: Sheet,
    description: "Pick the destination spreadsheet and how rows are written.",
  },
  {
    href: "/filters",
    label: "Filters & Rules",
    icon: Filter,
    description: "Choose which orders sync, and apply IF/THEN rules.",
  },
  {
    href: "/automation",
    label: "Automation",
    icon: Repeat,
    description: "Run syncs on a schedule instead of by hand.",
  },
  {
    href: "/sync-history",
    label: "Sync History",
    icon: Clock,
    description: "Every sync run, with per-step logs.",
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    description: "Account, integration, and security configuration.",
  },
];

export function navItemForPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
