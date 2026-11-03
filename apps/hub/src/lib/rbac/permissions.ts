import type { Role } from "@/lib/db/types";

export type Permission =
  | "org:read"
  | "org:write"
  | "users:invite"
  | "agents:read"
  | "agents:write"
  | "alerts:read"
  | "alerts:write"
  | "settings:write"
  | "setup:run";

const rolePermissions: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set([
    "org:read",
    "org:write",
    "users:invite",
    "agents:read",
    "agents:write",
    "alerts:read",
    "alerts:write",
    "settings:write",
    "setup:run",
  ]),
  operator: new Set([
    "org:read",
    "agents:read",
    "agents:write",
    "alerts:read",
    "alerts:write",
  ]),
  viewer: new Set(["org:read", "agents:read", "alerts:read"]),
};

export function can(role: Role, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new Error(`forbidden: ${role} lacks ${permission}`);
  }
}

export function roles(): Role[] {
  return ["admin", "operator", "viewer"];
}
