// ESM stand-in for path-browserify (posix subset) — audit ticket 5.
//
// monaco-yaml's prebuilt worker bundle imports `path-browserify`, which is
// CommonJS. In the Vite dev server the worker's imports are served as raw
// modules, so the CJS file executes as ESM and crashes with
// `module is not defined`, killing the YAML language worker (every request
// then rejects with "Missing requestHandler or method"). This shim provides
// the posix API surface the worker actually uses, as plain ESM. The alias in
// vite.config.ts points `path-browserify` here.
//
// In production builds the worker is bundled by Vite/Rolldown with CJS
// interop, so the real package would work — but dev and prod must behave the
// same, and this subset is complete for monaco-yaml's usage (basename,
// dirname, join, extname, resolve, parse, isAbsolute, posix.*).

function assertPath(path: string): void {
  if (typeof path !== "string") {
    throw new TypeError(`Path must be a string. Received ${JSON.stringify(path)}`);
  }
}

export function normalize(path: string): string {
  assertPath(path);
  if (path.length === 0) return ".";
  const isAbsolute = path.charCodeAt(0) === 47; /* / */
  const trailing = path.charCodeAt(path.length - 1) === 47;
  const parts: string[] = [];
  for (let i = 0; i < path.length;) {
    const start = i;
    while (i < path.length && path.charCodeAt(i) !== 47) i++;
    const part = path.slice(start, i);
    if (part === "" || part === ".") {
      // skip
    } else if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!isAbsolute) parts.push("..");
    } else {
      parts.push(part);
    }
    while (i < path.length && path.charCodeAt(i) === 47) i++;
  }
  let out = parts.join("/");
  if (out === "") out = isAbsolute ? "/" : ".";
  if (trailing && out !== "/") out += "/";
  return out;
}

export function isAbsolute(path: string): boolean {
  assertPath(path);
  return path.length > 0 && path.charCodeAt(0) === 47;
}

export function join(...paths: string[]): string {
  if (paths.length === 0) return ".";
  const joined = paths.filter((p) => p.length > 0).join("/");
  return joined === "" ? "." : normalize(joined);
}

export function dirname(path: string): string {
  assertPath(path);
  if (path.length === 0) return ".";
  const end = path.lastIndexOf("/");
  if (end === -1) return ".";
  if (end === 0) return "/";
  return path.slice(0, end);
}

export function basename(path: string, ext?: string): string {
  assertPath(path);
  const start = path.lastIndexOf("/") + 1;
  let base = path.slice(start);
  if (ext !== undefined && base.endsWith(ext) && base.length > ext.length) {
    base = base.slice(0, base.length - ext.length);
  }
  return base;
}

export function extname(path: string): string {
  assertPath(path);
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

export function resolve(...paths: string[]): string {
  let resolved = "";
  for (const p of paths) {
    assertPath(p);
    if (p.length > 0) {
      if (isAbsolute(p)) resolved = p;
      else resolved = resolved === "" ? p : `${resolved}/${p}`;
    }
  }
  if (resolved === "") return "/";
  return normalize(resolved);
}

export function parse(path: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
} {
  assertPath(path);
  const root = isAbsolute(path) ? "/" : "";
  const dir = dirname(path);
  const base = basename(path);
  const ext = extname(base);
  return { root, dir, base, ext, name: base.slice(0, base.length - ext.length) };
}

export const posix = {
  normalize,
  isAbsolute,
  join,
  dirname,
  basename,
  extname,
  resolve,
  parse,
};

export default posix;
