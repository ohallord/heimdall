import { describe, expect, it } from "vitest";

/**
 * Mirrors DashboardNav active rules (pathname-only; hashes are not in pathname).
 */
function isActive(
  pathname: string,
  label: string,
  href: string,
  match: string[] = [],
): boolean {
  if (label === "Fleet") return pathname === "/dashboard";
  if (label === "Servers") return pathname.startsWith("/dashboard/hosts");
  if (label === "Kubernetes") {
    return (
      pathname.startsWith("/dashboard/k8s") ||
      pathname.startsWith("/dashboard/clusters")
    );
  }
  if (pathname === href || pathname.startsWith(`${href}/`)) return true;
  return match.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

describe("dashboard nav active rules", () => {
  it("marks Fleet only on exact /dashboard", () => {
    expect(isActive("/dashboard", "Fleet", "/dashboard")).toBe(true);
    expect(isActive("/dashboard/alerts", "Fleet", "/dashboard")).toBe(false);
  });

  it("marks Servers on host routes only", () => {
    expect(isActive("/dashboard/hosts/a1", "Servers", "/dashboard#servers")).toBe(
      true,
    );
    expect(isActive("/dashboard", "Servers", "/dashboard#servers")).toBe(false);
  });

  it("marks Alarms and Security by path", () => {
    expect(isActive("/dashboard/alerts", "Alarms", "/dashboard/alerts")).toBe(
      true,
    );
    expect(
      isActive("/dashboard/remotes", "Security", "/dashboard/security", [
        "/dashboard/remotes",
      ]),
    ).toBe(true);
  });

  it("marks Services on list and detail routes", () => {
    expect(
      isActive("/dashboard/services", "Services", "/dashboard/services"),
    ).toBe(true);
    expect(
      isActive(
        "/dashboard/services/checkout",
        "Services",
        "/dashboard/services",
      ),
    ).toBe(true);
    expect(
      isActive("/dashboard/network", "Services", "/dashboard/services"),
    ).toBe(false);
  });
});
