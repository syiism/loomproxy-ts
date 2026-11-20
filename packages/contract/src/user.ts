// 用户名的唯一口径：长度 1–16（按 Unicode 码点计，避免 emoji/中文按 UTF-16 双计）。
// 后端校验与前端表单（Register.vue / admin/Users.vue）必须与此一致——改这里时前端两处同步。
export const USERNAME_MIN = 1
export const USERNAME_MAX = 16

/** 归一化：去首尾空白 + 转小写（与 DbUsers.create 的落库口径一致） */
export function normalizeUsername(v: string): string {
  return v.trim().toLowerCase()
}

/** 用户名长度是否合法（1–16 码点）。不含空白/小写归一化——调用方先 normalizeUsername。 */
export function validUsername(v: string): boolean {
  const n = [...v].length
  return n >= USERNAME_MIN && n <= USERNAME_MAX
}
