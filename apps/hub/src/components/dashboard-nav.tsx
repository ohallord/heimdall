"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type DashboardNavItem = {
  href: string;
  label: string;
  /** Path prefixes that mark this item active (in addition to href). */
  match?: string[];
  badge?: number;
};

const ITEMS: DashboardNavItem[] = [
  { href: "/dashboard", label: "Fleet", match: [] },
  {
    href: "/dashboard#servers",
    label: "Servers",
    match: ["/dashboard/hosts"],
  },
  {
    href: "/dashboard#kubernetes",
    label: "Kubernetes",
    match: ["/dashboard/k8s", "/dashboard/clusters"],
  },
  { href: "/dashboard/containers", label: "Containers" },
  { href: "/dashboard/network", label: "Network" },
  { href: "/dashboard/services", label: "Services" },
  {
    href: "/dashboard/security",
    label: "Security",
    match: ["/dashboard/remotes"],
  },
  { href: "/dashboard/logs", label: "Logs" },
  { href: "/dashboard/alerts", label: "Alarms" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/admin", label: "Admin" },
];

function isActive(pathname: string, item: DashboardNavItem): boolean {
  if (item.label === "Fleet") {
    return pathname === "/dashboard";
  }
  if (item.label === "Servers") {
    return pathname.startsWith("/dashboard/hosts");
  }
  if (item.label === "Kubernetes") {
    return (
      pathname.startsWith("/dashboard/k8s") ||
      pathname.startsWith("/dashboard/clusters")
    );
  }
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
    return true;
  }
  return (item.match ?? []).some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function DashboardNav({ openAlarmsCount = 0 }: { openAlarmsCount?: number }) {
  const pathname = usePathname() ?? "/dashboard";

  return (
    <nav
      className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs uppercase tracking-wide"
      aria-label="Operator console"
    >
      {ITEMS.map((item) => {
        const active = isActive(pathname, item);
        const badge =
          item.label === "Alarms" && openAlarmsCount > 0
            ? openAlarmsCount
            : item.badge;
        return (
          <Link
            key={item.label}
            href={item.href}
            className={
              active
                ? "text-signal underline decoration-signal/40 underline-offset-4"
                : "text-muted hover:text-foreground"
            }
            aria-current={active ? "page" : undefined}
          >
            {item.label}
            {badge != null && badge > 0 ? (
              <span className="ml-1 text-warn">({badge})</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
