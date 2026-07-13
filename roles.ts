export type Role = "supporter" | "creator" | "admin";
export const ROLES: Role[] = ["supporter", "creator", "admin"];
export function isRole(value: string): value is Role {
  return ROLES.includes(value as Role);
}
